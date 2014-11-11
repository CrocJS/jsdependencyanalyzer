"use strict";

var path = require('path');

var glob = require('glob');
var Q = require('q');
var _ = require('lodash');

var library = require('./library');
var cache = require('./cache');

glob = Q.denodeify(glob);

function defaultSymbol(ref, prefix) {
    return (prefix || '') + ref.replace(/\//g, '.');
}

var globCache = ':glob';
var lastSymbolId = 0;

/**
 * @param target
 * @constructor
 */
var SymbolsMap = function(target) {
    this.__target = target;
    this.__symbols = {};
};

SymbolsMap.prototype = {
    construct: SymbolsMap,

    create: function() {
        return Q

            .all(this.__target.sources.map(function(source) {
                var promise;
                var fullPath;
                var type = source.type || 'js';
                var mask = source.mask || ('**/*.' + type);
                var isGlob = !!source.path;

                if (source.path) {
                    fullPath = library.normalizePath(this.__target, source.path, true);

                    promise = Q().then(function() {
                        return cache.getData(globCache, fullPath) ||
                        glob(fullPath + mask).then(function(files) {
                            return cache.setData(globCache, fullPath, files);
                        });
                    });
                }
                else {
                    var files = [];
                    if (source.file) {
                        files = (Array.isArray(source.file) ? source.file : [source.file])
                            .map(function(x) { return library.normalizePath(this.__target, x); }, this);
                    }
                    promise = Q([files]);
                }

                return promise.then(function(files) {
                    files.forEach(function(file) {
                        var ref = isGlob && file.substr(fullPath.length);
                        if (ref && source.match && !(new RegExp(source.match).test(ref))) {
                            return;
                        }

                        ref = ref && ref.substr(0, ref.length - type.length - 1);
                        var symbol = !isGlob ? source.symbol :
                            source.symbol ? source.symbol(ref) : this.__getSymbol(ref, source);
                        if (isGlob && symbol === ':default') {
                            symbol = this.__getSymbol(ref, source);
                        }

                        if (symbol) {
                            var id = ++lastSymbolId;
                            var symbolParam = Array.isArray(symbol) ? symbol[0] : symbol;
                            var files = Array.isArray(file) ? file : [file];
                            this.__symbols[id] = {
                                id: id,
                                symbols: Array.isArray(symbol) ? symbol : [symbol],
                                files: files,
                                analyze: 'analyze' in source ? source.analyze : !!files.length,
                                dependencies: isGlob && typeof source.dependencies === 'function' ?
                                    source.dependencies(ref, symbolParam) : source.dependencies,
                                ignore: isGlob && typeof source.ignore === 'function' ?
                                    source.ignore(ref, symbolParam) : source.ignore,
                                weight: (isGlob && typeof source.weight === 'function' ?
                                    source.weight(ref, symbolParam) : source.weight) || 0,
                                type: type
                            };
                        }
                    }, this);
                }.bind(this));
            }.bind(this)))

            .then(function() {
                var filesHash = {};
                var symbolsHash = {};
                var typesHash = {};
                _.forOwn(this.__symbols, function(struct) {
                    struct.files.forEach(function(file) {
                        filesHash[file] = struct;
                    });
                    struct.symbols.forEach(function(symbol) {
                        symbolsHash[symbol] = struct;
                        if (!typesHash[struct.type]) {
                            typesHash[struct.type] = {};
                        }
                        typesHash[struct.type][symbol] = struct;
                    });
                });

                return Q({
                    symbols: this.__symbols,
                    filesHash: filesHash,
                    symbolsHash: symbolsHash,
                    typesHash: typesHash
                });
            }.bind(this));
    },

    __getSymbol: function(ref, source) {
        return defaultSymbol(ref, source.prefix);
    }
};

exports.create = function(target) {
    if (target.sources.$$symbolsMapCache) {
        return Q(target.sources.$$symbolsMapCache);
    }
    return new SymbolsMap(target).create().then(function(result) {
        target.sources.$$symbolsMapCache = result;
        return result;
    });
};

exports.defaultSymbol = defaultSymbol;