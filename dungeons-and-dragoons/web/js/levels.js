/**
 * levels.js — Dungeons & Dragoons
 * Tilemap level data for 3 stages.
 * Tile codes:
 *   . or 0 = empty
 *   # = stone wall
 *   T = stone top (lit + moss)
 *   D = dirt
 *   L = lava rock
 *   M = metal
 *   B = bone
 *   S = spikes (hazard)
 *   P = platform (one-way)
 *   p = player spawn
 *   g = goblin spawn
 *   k = skeleton spawn
 *   b = bat spawn
 *   m = slime spawn
 *   i = imp spawn
 *   W = boss wyrmling
 *   C = checkpoint
 *   @ = pickup (weapon/heart/coin — randomized)
 *   H = heart pickup
 *   $ = coin pickup
 *   t = torch decor
 *   c = chain decor
 *   & = skull pile decor
 *   ~ = banner decor
 */

export const TILE = 32;

export const STAGES = [
  {
    name: 'The Forgotten Crypt',
    bgFar: 'bg_crypt_far',
    bgNear: 'bg_crypt_near',
    tileset: { wall: 'tile_stone', top: 'tile_stone_top', dirt: 'tile_dirt', platform: 'tile_platform', spike: 'tile_spike', metal: 'tile_metal', bone: 'tile_bone', lava: 'tile_lava_rock' },
    boss: 'wyrmling',
    music: 'stage1',
    map: [
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '..............................t..........t.............t..............t.......................',
      '................................................................................................',
      '...........P..............P.................P..................P..............................',
      '................................................................................................',
      '................................................................................................',
      '....p........................g.........g..............g..............g..........g.............',
      '###########............#########............########...........#########.......................',
      '...........#...........#.......#............#......#...........#.......#.......................',
      '...........#...........#.......#............#......#...........#.......#.......................',
      '...........#############.......##############......#############.......###################WWWW#',
      '...........CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    ],
  },
  {
    name: 'The Lava Forge',
    bgFar: 'bg_forge_far',
    bgNear: 'bg_forge_near',
    tileset: { wall: 'tile_lava_rock', top: 'tile_stone_top', dirt: 'tile_dirt', platform: 'tile_platform', spike: 'tile_spike', metal: 'tile_metal', bone: 'tile_bone', lava: 'tile_lava_rock' },
    boss: 'lich',
    music: 'stage2',
    map: [
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '....t...........t..........t...........t..........t...........t..........t....................',
      '................................................................................................',
      '........P..............P.................P..................P..............................',
      '................................................................................................',
      '................................................................................................',
      '....p...........k....b........k........b........k....b........k....b........k....b............',
      'LLLLLLLLLLL............LLLLLLLLL............LLLLLLLL...........LLLLLLLLL.......................',
      '...........L...........L.......L............L......L...........L.......L.......................',
      '...........L...........L.......L............L......L...........L.......L.......................',
      '...........LLLLLLLLLLLLL.......LLLLLLLLLLLLLL......LLLLLLLLLLLLL.......LLLLLLLLLLLLLLLLLLLLLLL#',
      '...........CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL',
      'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL',
    ],
  },
  {
    name: "The Dragon's Roost",
    bgFar: 'bg_roost_far',
    bgNear: 'bg_roost_near',
    tileset: { wall: 'tile_metal', top: 'tile_stone_top', dirt: 'tile_dirt', platform: 'tile_platform', spike: 'tile_spike', metal: 'tile_metal', bone: 'tile_bone', lava: 'tile_lava_rock' },
    boss: 'dragon',
    music: 'stage3',
    map: [
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '................................................................................................',
      '....t...........t..........t...........t..........t...........t..........t....................',
      '................................................................................................',
      '........P..............P.................P..................P..............................',
      '................................................................................................',
      '................................................................................................',
      '....p...........m....i........m........i........m....i........m....i........m....i............',
      'MMMMMMMMMMM............MMMMMMMMM............MMMMMMMM...........MMMMMMMMM.......................',
      '...........M...........M.......M............M......M...........M.......M.......................',
      '...........M...........M.......M............M......M...........M.......M.......................',
      '...........MMMMMMMMMMMMM.......MMMMMMMMMMMMMM......MMMMMMMMMMMMM.......MMMMMMMMMMMMMMMMMMMMMMM#',
      '...........CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
      'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
    ],
  },
];

export function parseMap(rawMap) {
  const tiles = [];
  const spawns = [];
  const decor = [];
  let playerStart = null;
  let bossPos = null;
  let checkpoints = [];

  for (let y = 0; y < rawMap.length; y++) {
    const row = rawMap[y];
    const tileRow = [];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const px = x * TILE;
      const py = y * TILE;
      switch (ch) {
        case '#': tileRow.push('#'); break;
        case 'T': tileRow.push('T'); break;
        case 'D': tileRow.push('D'); break;
        case 'L': tileRow.push('L'); break;
        case 'M': tileRow.push('M'); break;
        case 'B': tileRow.push('B'); break;
        case 'S': tileRow.push('S'); break;
        case 'P': tileRow.push('P'); break;
        case 'p': tileRow.push('.'); playerStart = { x: px, y: py }; break;
        case 'g': tileRow.push('.'); spawns.push({ type: 'goblin', x: px, y: py }); break;
        case 'k': tileRow.push('.'); spawns.push({ type: 'skeleton', x: px, y: py }); break;
        case 'b': tileRow.push('.'); spawns.push({ type: 'bat', x: px, y: py }); break;
        case 'm': tileRow.push('.'); spawns.push({ type: 'slime', x: px, y: py }); break;
        case 'i': tileRow.push('.'); spawns.push({ type: 'imp', x: px, y: py }); break;
        case 'W': tileRow.push('.'); bossPos = { x: px, y: py }; break;
        case 'C': tileRow.push('.'); checkpoints.push({ x: px, y: py }); break;
        case '@': tileRow.push('.'); spawns.push({ type: 'pickup_weapon', x: px, y: py }); break;
        case 'H': tileRow.push('.'); spawns.push({ type: 'pickup_heart', x: px, y: py }); break;
        case '$': tileRow.push('.'); spawns.push({ type: 'pickup_coin', x: px, y: py }); break;
        case 't': tileRow.push('.'); decor.push({ type: 'decor_torch', x: px, y: py }); break;
        case 'c': tileRow.push('.'); decor.push({ type: 'decor_chain', x: px, y: py }); break;
        case '&': tileRow.push('.'); decor.push({ type: 'decor_skull_pile', x: px, y: py }); break;
        case '~': tileRow.push('.'); decor.push({ type: 'decor_banner', x: px, y: py }); break;
        default: tileRow.push('.');
      }
    }
    tiles.push(tileRow);
  }

  return { tiles, spawns, decor, playerStart, bossPos, checkpoints, width: rawMap[0].length * TILE, height: rawMap.length * TILE };
}

export function tileSpriteName(stage, tileCode) {
  const ts = stage.tileset;
  switch (tileCode) {
    case '#': return ts.wall;
    case 'T': return ts.top;
    case 'D': return ts.dirt;
    case 'L': return ts.lava;
    case 'M': return ts.metal;
    case 'B': return ts.bone;
    case 'S': return ts.spike;
    case 'P': return ts.platform;
    default: return null;
  }
}
