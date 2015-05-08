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
 * todo оптимизировать
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
    this.__symbolsHash = {};
    
    var sources = _.flatten(this.__target.sources.map(function(source) {
        if (typeof source.path === 'object') {
            return _.map(source.path, function(prefix, curPath) {
                return _.assign({}, source, {
                    path: curPath,
                    prefix: prefix
                });
            });
        }
        return source;
    }));
    
    var excludes = {};
    sources.forEach(function(source, i) {
        if (source.exclude) {
            (Array.isArray(source.exclude) ? source.exclude : [source.exclude])
                .forEach(function(exclude) {
                    excludes[exclude] = i;
                });
        }
    });
    
    this.__result = Q
        
        .all(sources.map(function(source, sourceIndex) {
            if (source.exclude) {
                return;
            }
            
            var promise;
            var fullPath;
            var types = source.type || ['js'];
            if (!Array.isArray(types)) {
                types = [types];
            }
            var mask = source.mask || ('**/*.@(' + types.join('|') + ')');
            var isGlob = source.path !== undefined;
            
            if (isGlob) {
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
                promise = Q(files);
            }
            
            return promise.then(function(files) {
                files.forEach(function(file) {
                    var ref = isGlob && file.substr(fullPath.length);
                    //if (ref && source.match && !(new RegExp(source.match).test(ref))) {
                    //    return;
                    //}
                    
                    ref = ref && ref.slice(0, -path.extname(ref).length);
                    var symbol = !isGlob ? source.symbol :
                        source.symbol ? source.symbol(ref) : this.__getSymbol(ref, source);
                    if (isGlob && symbol === ':default') {
                        symbol = this.__getSymbol(ref, source);
                    }
                    
                    if (symbol) {
                        var symbols = Array.isArray(symbol) ? symbol : [symbol];
                        var symbolParam = symbols[0];
                        
                        if (symbols.some(function(x) { return x in excludes && excludes[x] > sourceIndex; })) {
                            return;
                        }
                        
                        var struct = this.__symbolsHash[symbolParam];
                        if (!struct) {
                            var id = ++lastSymbolId;
                            struct = this.__symbols[id] = {
                                id: id,
                                symbols: [],
                                files: [],
                                analyze: [],
                                dependencies: {},
                                ignore: {},
                                weight: {},
                                types: []
                            };
                            if (source.meta) {
                                struct.meta = source.meta;
                            }
                        }
                        
                        var fileType = path.extname(file).substr(1);
                        var params = [ref, symbolParam, fileType];
                        
                        struct.symbols = _.union(struct.symbols, symbols);
                        struct.types = _.union(struct.types, types);
                        _.assign(struct.dependencies, this.__resolveParam(source.dependencies, params));
                        if (file) {
                            struct.files.push(file);
                            struct.ignore[file] = this.__resolveParam(source.ignore, params) || [];
                            struct.weight[file] = this.__resolveParam(source.weight, params) || 0;
                            if ('analyze' in source ? source.analyze : true) {
                                struct.analyze.push(file);
                            }
                        }
                        
                        symbols.forEach(function(symbol) {
                            this.__symbolsHash[symbol] = struct;
                        }, this);
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
    return (prefix || '') + ref.replace(/\/index$/, '').replace(/\//g, '.');
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
        var typesHash = {};
        _.forOwn(this.__symbols, function(struct) {
            struct.files.forEach(function(file) {
                filesHash[file] = struct;
            });
            struct.symbols.forEach(function(symbol) {
                struct.types.forEach(function(type) {
                    if (!typesHash[type]) {
                        typesHash[type] = {};
                    }
                    typesHash[type][symbol] = struct;
                });
            });
        });
        
        return Q({
            symbols: this.__symbols,
            filesHash: filesHash,
            symbolsHash: this.__symbolsHash,
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
    },
    
    /**
     * @param param
     * @param params
     * @returns {*}
     * @private
     */
    __resolveParam: function(param, params) {
        return typeof param === 'function' ? param.apply(global, params) : param;
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