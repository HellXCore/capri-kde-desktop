'use strict';
// Spike entry: this copy stays INSIDE app.asar in the packaged build,
// so loading it proves (or disproves) asar support in the child process.
require('./probes.js');