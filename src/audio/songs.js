// Built-in song list. Every track is generated procedurally from this definition
// (see ./synth.js: composeSong → renderSong), so the game ships without a single audio file.
//
// Fields:
//   id         stable identifier (used for scores / seeds / URLs)
//   title      display title (English)
//   artist     display artist
//   style      arrangement + sound-design preset in synth.js:
//              'synthwave' | 'darksynth' | 'house' | 'trance' | 'dubstep' | 'chiptune' | 'dnb' | 'hardcore'
//   bpm        tempo (quarter notes per minute)
//   key/scale  tonal centre ('A', 'F#', ...) and mode ('minor' | 'major' | 'dorian' | ...)
//   seed       composition seed — change it and you get a different track in the same style
//   lengthSec  target length in seconds; the real length snaps to whole 4-bar phrases (± a few s)
//   color      accent colour for menus / background visuals
//   mood       short Russian description for the song select screen
//
// The list is ordered roughly from easiest to hardest: the first song is the beginner-friendly one.

export const SONGS = [
  {
    id: 'neon-drift',
    title: 'Neon Drift',
    artist: 'MUXA Synth',
    style: 'synthwave',
    bpm: 112,
    key: 'A',
    scale: 'minor',
    seed: 1984,
    lengthSec: 106,
    color: '#ff3d9a',
    mood: 'Ночная трасса, неон и тёплые аналоговые пэды. Спокойный темп — идеально для разминки.',
  },
  {
    id: 'chrome-requiem',
    title: 'Chrome Requiem',
    artist: 'MUXA Synth',
    style: 'darksynth',
    bpm: 96,
    key: 'D',
    scale: 'minor',
    seed: 6660,
    lengthSec: 100,
    color: '#b44dff',
    mood: 'Мрачный дарксинт: тяжёлая бочка, рычащий бас шестнадцатыми и холодные арпеджио.',
  },
  {
    id: 'midnight-circuit',
    title: 'Midnight Circuit',
    artist: 'MUXA Synth',
    style: 'house',
    bpm: 126,
    key: 'F',
    scale: 'minor',
    seed: 31337,
    lengthSec: 118,
    color: '#43e8ff',
    mood: 'Клубный хаус: бочка в пол, офбитный бас, клэпы и аккордовые стабы в эхе.',
  },
  {
    id: 'starlight-protocol',
    title: 'Starlight Protocol',
    artist: 'MUXA Synth',
    style: 'trance',
    bpm: 138,
    key: 'G',
    scale: 'minor',
    seed: 138138,
    lengthSec: 140,
    color: '#4d7cff',
    mood: 'Эпичный транс: огромные суперсо, катящийся бас и бесконечные арпеджио к звёздам.',
  },
  {
    id: 'gravity-well',
    title: 'Gravity Well',
    artist: 'MUXA Synth',
    style: 'dubstep',
    bpm: 140,
    key: 'F#',
    scale: 'minor',
    seed: 404,
    lengthSec: 112,
    color: '#9dff00',
    mood: 'Халф-тайм дабстеп: воббл-бас, который рвёт колонки, и снейр как удар молота.',
  },
  {
    id: 'pixel-crusade',
    title: 'Pixel Crusade',
    artist: 'MUXA Synth',
    style: 'chiptune',
    bpm: 150,
    key: 'E',
    scale: 'dorian',
    seed: 8086,
    lengthSec: 96,
    color: '#7cff6b',
    mood: '8-битный поход героя: квадратные волны, шумовые барабаны и бешеные арпеджио.',
  },
  {
    id: 'velocity-rush',
    title: 'Velocity Rush',
    artist: 'MUXA Synth',
    style: 'dnb',
    bpm: 174,
    key: 'C',
    scale: 'minor',
    seed: 1740,
    lengthSec: 126,
    color: '#ffb13d',
    mood: 'Драм-н-бейс на 174: ломаный брейк, риз-бас и чистая скорость.',
  },
  {
    id: 'hyperdrive-overload',
    title: 'Hyperdrive Overload',
    artist: 'MUXA Synth',
    style: 'hardcore',
    bpm: 188,
    key: 'B',
    scale: 'major',
    seed: 188188,
    lengthSec: 112,
    color: '#ff2e4d',
    mood: 'Хардкор на 188 BPM: искажённая бочка, суперсо-лид и стримы для настоящих безумцев.',
  },
];

/** Look up a song definition by id (undefined if not found). */
export function songById(id) {
  return SONGS.find((s) => s.id === id);
}
