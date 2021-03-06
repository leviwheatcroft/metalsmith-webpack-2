'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
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

const modTimes = new _metalsmithCache.ValueCache('webpack-mod-times');
const metaCache = new _metalsmithCache.ValueCache('webpack');
const fileCache = new _metalsmithCache.FileCache('webpack');

let fromCache;

/**
 * ##plugin
 *
 * @param {Object} options webpack options
 */
function plugin() {
  let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 'webpack.config.js';
  let dependencies = arguments[1];

  return function webpack(files, metalsmith) {
    // deal with options inside plugin so we have access to metalsmith
    if (typeof options === 'string' || options.config === undefined) options = { config: options };
    if (typeof options.config === 'string') {
      options.config = require(metalsmith.path(options.config));
    }
    if (!Array.isArray(options.config)) options.config = [options.config];

    fromCache = true;

    return _vow2.default.resolve().then(() => invalidate(options)).then(() => validateCache(dependencies, files)).catch(reason => transpile(reason, options, metalsmith)).then(() => populate(files, metalsmith)).catch(dbg);
  };
}

function invalidate(options) {
  if (options.clearCache || options.invalidate) {
    return _vow2.default.all([modTimes.invalidate(), fileCache.invalidate(), metaCache.invalidate()]);
  }
}

function validateCache(dependencies, files) {
  if (!dependencies) return _vow2.default.reject('no dependencies specified');
  if (process.env.NODE_ENV === 'production') {
    return _vow2.default.reject('production build');
  }

  dependencies = [].concat(dependencies);
  dependencies = (0, _multimatch2.default)(Object.keys(files), dependencies);
  if (dependencies.length === 0) {
    return _vow2.default.reject('dependencies matched 0 files');
  }
  const resolvers = dependencies.map(file => {
    const current = files[file].stats.mtime.getTime();
    return _vow2.default.resolve().then(() => modTimes.retrieve(file)).then(cached => {
      if (cached !== current) return _vow2.default.reject();
    });
  });
  return _vow2.default.all(resolvers).then(() => {
    dbg('cache valid, skipping transpile');
  }).catch(() => {
    return _vow2.default.resolve().then(() => modTimes.invalidate()).then(() => {
      // you can't just do this as part of the above resolver structure,
      // because only the first updated time would be stored, then the structure
      // would reject.
      const resolvers = dependencies.map(file => {
        return modTimes.store(file, files[file].stats.mtime.getTime());
      });
      return _vow2.default.all(resolvers);
    }).then(() => fileCache.invalidate()).then(() => _vow2.default.reject('dependencies changed'));
  });
}

function transpile(reason, options, metalsmith) {
  dbg(`cache invalid (will transpile): ${reason}`);

  const compiler = (0, _webpack2.default)(options.config);
  const fs = new _memoryFs2.default();
  compiler.outputFileSystem = fs;

  fromCache = false;

  return promisify(compiler.run.bind(compiler))().then(stats => {
    if (stats.hasErrors()) throw new Error(stats);
    return metaCache.store('statsDisplay', stats.toString(options.stats)).then(() => metaCache.store('stats', stats.toJson())).then(() => {
      dbg('stored');
      // *assetsByChunkName* will have a property for each chunkName from
      // all children, containing an array of buildPaths for assets
      const assetsByChunkName = {};

      // the async writes to cache don't need to complete before the next
      // iteration, so each write operation can be stored in an array, then
      // at the end wrap all those ops in vow.all
      const resolvers = [];

      // this doesn't actually output json, rather a plain object
      stats = stats.toJson();
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
            resolvers.push(fileCache.store(buildPath, { contents: fs.readFileSync(fullPath) }));
            // store buildPath
            assetsByChunkName[chunkName].push(buildPath);
          });
        });
      });
      resolvers.push(metaCache.store('assetsByChunkName', assetsByChunkName));
      return _vow2.default.all(resolvers).then(() => _vow2.default.resolve(assetsByChunkName));
    });
  });
}

function populate(files, metalsmith) {
  let assetsByChunkName;
  let meta;
  let stats;
  return _vow2.default.resolve().then(() => metaCache.retrieve('assetsByChunkName')).then(result => {
    assetsByChunkName = result;
    const resolvers = [];
    Object.values(assetsByChunkName).forEach(assets => {
      resolvers.concat(assets.map(asset => {
        return fileCache.retrieve(asset).then(file => {
          // dbg(Object.keys(file.contents))
          files[asset] = file;
        });
      }));
    });
    return _vow2.default.all(resolvers);
  }).then(() => metaCache.retrieve('stats')).then(result => {
    stats = Object.assign(result, { fromCache: fromCache });
    meta = metalsmith.metadata();

    // one chunk may have multiple assets, in meta we're just going to
    // store the path to the last asset. Probably wont work for all uses.
    const assets = {};
    Object.keys(assetsByChunkName).forEach(chunkName => {
      assets[chunkName] = (0, _path.join)(_path.sep, assetsByChunkName[chunkName].slice(-1).join());
    });
    meta.webpack = { stats: stats, assets: assets
      // dump this to show consumers whats in the meta / assets structure
    };dbg(assets);
  }).then(() => metaCache.retrieve('statsDisplay')).then(result => {
    // dump stats
    dbg(result);
  });
}

/**
 * ## promisify
 * wrap fn with promise.. should probably use some package
 */
function promisify(fn) {
  return function () {
    const defer = _vow2.default.defer();

    for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

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