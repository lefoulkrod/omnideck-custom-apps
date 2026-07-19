export async function invoke(action, args = {}) {
  if (!window.omnideck?.invoke) {
    throw new Error('The Omnideck Custom App SDK is not available.');
  }
  const result = await window.omnideck.invoke(action, args);
  if (result?.error) throw new Error(result.error);
  return result;
}

export function composeChat(text, context = null) {
  if (!window.omnideck?.chat?.compose) return false;
  window.omnideck.chat.compose({ text, context });
  return true;
}
