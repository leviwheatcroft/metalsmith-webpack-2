'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.cache = undefined;
exports.default = plugin;

var _path = require('path');

var _webpack = require('webpack');

var _webpack2 = _interopRequireDefault(_webpack);

var _debug = require('debug');

var _debug2 = _interopRequireDefault(_debug);

var _memoryFs = require('memory-fs');

var _memoryFs2 = _interopRequireDefault(_memoryFs);

var _vow = require('vow');

var _vow2 = _interopRequireDefault(_vow);

var _metalsmithCache = require('metalsmith-cache');

var _multimatch = require('multimatch');

var _multimatch2 = _interopRequireDefault(_multimatch);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const dbg = (0, _debug2.default)('metalsmith-webpack');

// import {
//   readFile
// } from 'fs'

const modTimes = (0, _metalsmithCache.getStore)('webpackModTimes');
const persist = (0, _metalsmithCache.getStore)('metalsmith-cache');

exports.cache = _metalsmithCache.loki;


let fromCache;

/**
 * ##plugin
 *
 * @param {Object} options webpack options
 */
function plugin(options = 'webpack.config.js', dependencies) {
  return function (files, metalsmith) {
    // deal with options inside plugin so we have access to metalsmith
    if (typeof options === 'string' || options.config === undefined) options = { config: options };
    if (typeof options.config === 'string') {
      options.config = require(metalsmith.path(options.config));
    }
    if (!Array.isArray(options.config)) options.config = [options.config];

    if (options.clearCache) {
      modTimes.clear();
      _metalsmithCache.files.clear();
      persist.clear();
    }

    fromCache = true;

    return _vow2.default.resolve().then(() => (0, _metalsmithCache.init)()).then(() => validateCache(dependencies, files)).catch(() => transpile(options, metalsmith)).then(() => populate(files, metalsmith)).catch(dbg).then(() => (0, _metalsmithCache.save)());
  };
}

function validateCache(dependencies, files) {
  if (!dependencies) return _vow2.default.reject(); // must transpile

  dependencies = [].concat(dependencies);
  let results = (0, _multimatch2.default)(Object.keys(files), dependencies).map(file => {
    const current = files[file].stats.mtime;
    const cached = modTimes.retrieve(file);
    if (cached && cached.getTime() === current.getTime()) return false;
    modTimes.store(file, current);
    return true;
  });
  if (results.includes(true)) return _vow2.default.reject();
  if (results.length === 0) {
    dbg('your dependencies mask didnt match any files, build forced');
    dbg(dependencies);
    return _vow2.default.reject();
  }
  return _vow2.default.resolve();
}
function transpile(options, metalsmith) {
  const compiler = (0, _webpack2.default)(options.config);
  const fs = new _memoryFs2.default();
  compiler.outputFileSystem = fs;

  fromCache = false;

  return promisify(compiler.run.bind(compiler))().then(stats => {
    if (stats.hasErrors()) throw new Error(stats);
    persist.store('statsDisplay', stats.toString(options.stats));
    stats = stats.toJson(); // scandalous !!
    persist.store('stats', stats);

    // *assetsByChunkName* will have a property for each chunkName from
    // all children, containing an array of buildPaths for assets
    const assetsByChunkName = {};

    // *iterate over `stats.children` array*
    // there will be one child for each config, if you're passing in an array
    // need to access assets from stats.children[idx] and output path from
    // config[idx].output.path so iterate over keys rather than `for in` style
    Object.keys(stats.children).forEach(childIdx => {
      const child = stats.children[childIdx];
      const outputPath = options.config[childIdx].output.path;

      // *iterate over `assetsByChunkName` property*
      // I think a chunk is roughly equivalent to an entry point (not sure?)
      // so if you set several entry points, you'll have corresponding
      // assets for each chunk name
      Object.keys(child.assetsByChunkName).forEach(chunkName => {
        assetsByChunkName[chunkName] = [];
        // [].concat ensures array
        let assets = [].concat(child.assetsByChunkName[chunkName]);
        assets.forEach(assetName => {
          // fullPath (absolute) to asset, as it's stored in memory
          const fullPath = (0, _path.join)(outputPath, assetName);
          // buildPath (relative) path to asset as it will be stored in ms
          const buildPath = (0, _path.relative)(metalsmith.destination(), fullPath);
          // store file in cache
          _metalsmithCache.files.store(buildPath, { contents: fs.readFileSync(fullPath) });
          // store buildPath
          assetsByChunkName[chunkName].push(buildPath);
        });
      });
    });
    persist.store('assetsByChunkName', assetsByChunkName);
    return _vow2.default.resolve(assetsByChunkName);
  });
}

function populate(files, metalsmith) {
  const assetsByChunkName = persist.retrieve('assetsByChunkName');
  Object.values(assetsByChunkName).forEach(assets => {
    assets.forEach(asset => {
      files[asset] = _metalsmithCache.files.retrieve(asset);
    });
  });

  // populate meta with references and stats
  const meta = metalsmith.metadata();
  const stats = persist.retrieve('stats');

  // allow tests etc to detect whether cache was used
  stats.fromCache = fromCache;

  // one chunk may have multiple assets, in meta we're just going to
  // store the path to the last asset. Probably wont work for all uses.
  const assets = {};
  Object.keys(assetsByChunkName).forEach(chunkName => {
    assets[chunkName] = (0, _path.join)(_path.sep, assetsByChunkName[chunkName].slice(-1).join());
  });
  meta.webpack = { stats, assets };

  // show plugin users the standard webpack stats
  dbg(persist.retrieve('statsDisplay'));
  dbg(assets);
  return _vow2.default.resolve();
}

/**
 * ## promisify
 * wrap fn with promise.. should probably use some package
 */
function promisify(fn) {
  return function (...args) {
    const defer = _vow2.default.defer();

    args.push((err, result) => {
      if (err) return defer.reject(err);
      defer.resolve(result);
    });
    try {
      fn.apply(this, args);
    } catch (err) {
      defer.reject(err);
    }
    return defer.promise();
  };
}