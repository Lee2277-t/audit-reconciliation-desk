const path = require('node:path');
const { root, copyApp } = require('./release-files.cjs');
copyApp(path.join(root, 'desktop', 'app'));
console.log('DESKTOP_READY');
