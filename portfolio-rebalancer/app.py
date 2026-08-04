"""Portfolio Rebalancer backend.

Ingests an allocation CSV (Empower + E*Trade), pulls live prices, and
computes dollar-precise buy/sell trade tickets to bring each holding back
to its target allocation.
"""
import csv
import json
import os
import urllib.request

from custom_apps import action

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DEFAULT_CSV = os.path.join(DATA_DIR, "portfolio.csv")

# Columns in the allocation CSV
TICKER = "TICKER"
ASSET = "Asset Class"
EMP_SHARES = "EMPOWER SHARES"
PRICE = "PRICE"
EMP_AMT = "EMPOWER"
EMP_PCT = "EMPOWER ALLOCATION"
ETR_SHARES = "ETRADE SHARES"
ETR_AMT = "ETRADE ACTUAL AMT"
ETR_PCT = "ETRADE ACTUAL PCT"
DELTA = "DELTA"


def _clean(value):
    """Strip $, commas, % and whitespace; return float or None."""
    if value is None:
        return None
    s = str(value).replace("$", "").replace(",", "").replace("%", "").strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_csv(path):
    """Parse the allocation CSV into a list of holding dicts."""
    holdings = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ticker = (row.get(TICKER) or "").strip().upper()
            if not ticker or ticker == "TOTALS":
                continue
            holdings.append(
                {
                    "ticker": ticker,
                    "asset_class": (row.get(ASSET) or "").strip(),
                    "empower_shares": _clean(row.get(EMP_SHARES)) or 0.0,
                    "price": _clean(row.get(PRICE)) or 0.0,
                    "empower_amt": _clean(row.get(EMP_AMT)) or 0.0,
                    "empower_pct": _clean(row.get(EMP_PCT)) or 0.0,
                    "etrade_shares": _clean(row.get(ETR_SHARES)) or 0.0,
                    "etrade_amt": _clean(row.get(ETR_AMT)) or 0.0,
                    "etrade_pct": _clean(row.get(ETR_PCT)) or 0.0,
                    "delta": _clean(row.get(DELTA)) or 0.0,
                }
            )
    return holdings


def _fetch_live_price(ticker, timeout=8):
    """Fetch a live price for a ticker from Yahoo Finance.

    Returns the last close price, or None on any failure.
    """
    url = (
        "https://query2.finance.yahoo.com/v8/finance/chart/"
        f"{ticker}?range=1d&interval=1d"
    )
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (portfolio-rebalancer)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        result = data["chart"]["result"][0]
        meta = result.get("meta", {})
        price = meta.get("regularMarketPrice") or meta.get("previousClose")
        if price:
            return float(price)
        # fall back to last close in the series
        closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])
        for c in reversed(closes):
            if c is not None:
                return float(c)
    except Exception:
        return None
    return None


def _live_prices(holdings):
    """Return {ticker: price} using live data, falling back to CSV price."""
    prices = {}
    for h in holdings:
        live = _fetch_live_price(h["ticker"])
        prices[h["ticker"]] = live if live else h["price"]
    return prices


@action
def rebalance(csv_path=None, account="combined", use_live=True):
    """Compute a rebalancing plan.

    account: 'combined' (whole portfolio), 'empower', or 'etrade'.
    Returns holdings with current values, target values, and trade tickets.
    """
    path = csv_path or DEFAULT_CSV
    holdings = _parse_csv(path)
    if not holdings:
        return {"error": "No holdings found in CSV."}

    prices = _live_prices(holdings) if use_live else {h["ticker"]: h["price"] for h in holdings}

    # Determine which account(s) to rebalance
    def account_value(h, acct):
        if acct == "empower":
            return h["empower_shares"] * prices[h["ticker"]]
        if acct == "etrade":
            return h["etrade_shares"] * prices[h["ticker"]]
        return (h["empower_shares"] + h["etrade_shares"]) * prices[h["ticker"]]

    # Total portfolio value (both accounts) is the base for target allocation
    total_value = sum(
        (h["empower_shares"] + h["etrade_shares"]) * prices[h["ticker"]]
        for h in holdings
    )
    if total_value <= 0:
        return {"error": "Total portfolio value is zero."}

    # Normalize target percentages (they should sum to ~100)
    target_sum = sum(h["empower_pct"] for h in holdings)
    if target_sum <= 0:
        target_sum = 100.0

    rows = []
    for h in holdings:
        live_price = prices[h["ticker"]]
        cur_value = account_value(h, account)
        target_pct = h["empower_pct"] / target_sum * 100.0
        target_value = total_value * (target_pct / 100.0)
        delta = target_value - cur_value

        # Build a trade ticket for this holding
        ticket = None
        if abs(delta) >= 1.0 and live_price > 0:
            shares = round(delta / live_price, 2)
            ticket = {
                "action": "BUY" if delta > 0 else "SELL",
                "ticker": h["ticker"],
                "shares": abs(shares),
                "approx_amount": round(abs(delta), 2),
                "price": round(live_price, 2),
            }

        rows.append(
            {
                "ticker": h["ticker"],
                "asset_class": h["asset_class"],
                "price": round(live_price, 2),
                "price_source": "live" if use_live and prices[h["ticker"]] != h["price"] else "csv",
                "current_value": round(cur_value, 2),
                "current_pct": round(cur_value / total_value * 100.0, 2),
                "target_pct": round(target_pct, 2),
                "target_value": round(target_value, 2),
                "delta": round(delta, 2),
                "ticket": ticket,
            }
        )

    rows.sort(key=lambda r: r["delta"])
    total_cur = sum(r["current_value"] for r in rows)
    total_trades = sum(1 for r in rows if r["ticket"])
    total_buy = sum(r["ticket"]["approx_amount"] for r in rows if r["ticket"] and r["ticket"]["action"] == "BUY")
    total_sell = sum(r["ticket"]["approx_amount"] for r in rows if r["ticket"] and r["ticket"]["action"] == "SELL")

    return {
        "account": account,
        "total_value": round(total_value, 2),
        "total_current": round(total_cur, 2),
        "holdings": rows,
        "summary": {
            "trades": total_trades,
            "total_buy": round(total_buy, 2),
            "total_sell": round(total_sell, 2),
            "net_cash_needed": round(total_buy - total_sell, 2),
        },
        "as_of": prices,
    }


@action
def get_portfolio(csv_path=None):
    """Return the parsed portfolio holdings (no live prices)."""
    path = csv_path or DEFAULT_CSV
    holdings = _parse_csv(path)
    return {"holdings": holdings, "count": len(holdings)}


@action
def ping():
    return {"ok": True, "app": "portfolio-rebalancer"}
