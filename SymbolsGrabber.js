"use strict";

var path = require('path');

var Q = require('q');
var glob = Q.denodeify(require('glob'));
var _ = require('lodash');
var program = require('commander');

var library = require('./library');
var cache = require('./cache');

var cacheKey = ':glob';
var cacheInvalidated = false;
var oldGlobData;
var lastSymbolId = 0;

/**
 * Сканирует файловую структуру и составляет список доступных символов и связанных с ними файлами
 * @param {Object} target
 * @constructor
 */
var SymbolsGrabber = function(target) {
    if (target.sources.$$symbolsMapCache) {
        this.__result = Q(target.sources.$$symbolsMapCache);
        return;
    }

    this.__target = target;
    this.__symbols = {};

    this.__result = Q

        .all(this.__target.sources.map(function(source) {
            var promise;
            var fullPath;
            var type = source.type || 'js';
            var mask = source.mask || ('**/*.' + type);
            var isGlob = !!source.path;

            if (source.path) {
                fullPath = library.normalizePath(this.__target, source.path, true);

                promise = Q().then(function() {
                    return cache.getData(cacheKey, fullPath) ||
                    glob(fullPath + mask).then(function(files) {
                        //удаляем кеш если изменилась файловая структура
                        var oldGlobCache = oldGlobData && oldGlobData[fullPath];
                        if (!cacheInvalidated && oldGlobCache && _.xor(files, oldGlobCache).length > 0) {
                            cache.invalidate();
                            cacheInvalidated = true;
                        }
                        return cache.setData(cacheKey, fullPath, files);
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

        .then(this.__createResult.bind(this))
        .then(function(result) {
            this.__target.sources.$$symbolsMapCache = result;
            return result;
        }.bind(this));
};

SymbolsGrabber.defaultSymbol = function(ref, prefix) {
    return (prefix || '') + ref.replace(/\//g, '.');
};

SymbolsGrabber.prototype = {
    constructor: SymbolsGrabber,

    /**
     * Результат работы компонента
     * @returns {Q.promise}
     */
    getResult: function() {
        return this.__result;
    },

    /**
     * @returns {*}
     * @private
     */
    __createResult: function() {
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
    },

    /**
     * @param ref
     * @param source
     * @returns {*}
     * @private
     */
    __getSymbol: function(ref, source) {
        return SymbolsGrabber.defaultSymbol(ref, source.prefix);
    }
};

cache.onRestore(function() {
    var globCache = cache.getDataSection(cacheKey);
    if (globCache && program.dirChangeInfo) {
        //удаляем кеш если изменилась структура css-файлов
        if ((program.added.concat(program.removed))
                .some(function(x) { return path.extname(x) === '.css'; })) {
            cache.invalidate();
        }
        else {
            //корректируем кеш исходя из переданных параметров added, removed
            _.forOwn(globCache, function(files, wildcard) {
                program.added.forEach(function(addedFile) {
                    if (addedFile.indexOf(wildcard) === 0) {
                        if (files.indexOf(addedFile) === -1) {
                            files.push(addedFile);
                        }
                    }
                });

                program.removed.forEach(function(removedFile) {
                    if (removedFile.indexOf(wildcard) === 0) {
                        var i = files.indexOf(removedFile);
                        if (i !== -1) {
                            files.splice(i, 1);
                        }
                    }
                });
            });
        }
    }
    else if (!program.nodirchange) {
        oldGlobData = globCache;
        cache.removeDataSection(cacheKey);
    }
});

module.exports = SymbolsGrabber;