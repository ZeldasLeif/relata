// Relata configuration — edit freely.
// Types: `key` is what is shown on the node and stored in the JSON,
// `color` is the (muted) accent used for the type strip and title tint.
window.RELATA_CONFIG = {
  nodeWidth: 260,
  defaultType: 'CHARACTER',
  types: [
    { key: 'CHARACTER', color: '#c4948a' }, // dusty rose
    { key: 'LOCATION',  color: '#93a98a' }, // sage
    { key: 'EVENT',     color: '#c9a96e' }, // ochre
    { key: 'FACTION',   color: '#8fa0b8' }, // slate blue
    { key: 'ARTIFACT',  color: '#a993b0' }, // plum
    { key: 'LORE',      color: '#85aaa6' }, // teal
    { key: 'NOTE',      color: '#a8a091' }, // warm grey
  ],
  // Connection styles offered in the right-click menu of a line.
  edgeColors: [
    { name: 'Default', color: '' },
    { name: 'Rose',    color: '#c4948a' },
    { name: 'Ember',   color: '#c0705c' },
    { name: 'Ochre',   color: '#c9a96e' },
    { name: 'Sage',    color: '#93a98a' },
    { name: 'Teal',    color: '#85aaa6' },
    { name: 'Slate',   color: '#8fa0b8' },
    { name: 'Plum',    color: '#a993b0' },
  ],
  edgeWidths: [
    { name: 'Thin',    width: 1 },
    { name: 'Regular', width: 1.5 },
    { name: 'Bold',    width: 2.75 },
    { name: 'Heavy',   width: 4.5 },
  ],
};
