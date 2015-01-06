"use strict";

var path = require('path');

var Q = require('q');
var _ = require('lodash');
var program = require('commander');

var library = require('./library');
var FileScanner = require('./FileScanner');
var SymbolsGrabber = require('./SymbolsGrabber');

var lastSymbolId = 0;

/**
 * Расчитывает зависимости для переданной цели
 * @param {Object} target
 * @param {Array.<string>} ignoreFiles
 * @constructor
 */
var DependenciesCalculator = function(target, ignoreFiles) {
    this.__target = target;
    this.__ignoreFiles = {};
    if (ignoreFiles) {
        ignoreFiles.forEach(function(file) {
            this.__ignoreFiles[file] = true;
        }, this);
    }

    this.__result = new SymbolsGrabber(this.__target).getResult()
        .then(function(result) {
            this.__symbols = result.symbols;
            this.__filesHash = result.filesHash;
            this.__symbolsHash = result.symbolsHash;
            this.__symbolsMap = result;

            this.__findPackages();

            this.__includedIds = {};
            this.__filesList = [];
            this.__addDeps = {};

            var promise = Q();
            this.__target.include.forEach(function(item) {
                promise = promise.then(function() {
                    return this.__addTargetChunk(this.__getSymbolStruct(item));
                }.bind(this));
            }, this);

            return promise;
        }.bind(this))

        .then(function() {
            var files = this.__filesList;
            var hash = this.__filesHash;
            return files.concat().sort(function(a, b) {
                var aWeight = hash[a].weight[a];
                var bWeight = hash[b].weight[b];
                return aWeight === bWeight ? files.indexOf(a) - files.indexOf(b) : aWeight - bWeight;
            }.bind(this));
        }.bind(this));
};

DependenciesCalculator.prototype = {
    constructor: DependenciesCalculator,

    /**
     * Хеш - имя файла: структура символа
     * @returns {Object}
     */
    getFilesHash: function() {
        return this.__filesHash;
    },

    /**
     * Результат работы компонента
     * @returns {Q.promise}
     */
    getResult: function() {
        return this.__result;
    },

    /**
     * @param symbolStruct
     * @returns {Q.promise}
     * @private
     */
    __addTargetChunk: function(symbolStruct) {
        this.__dependencyDeferred = Q.defer();
        this.__resultsHash = {};
        this.__depencencyCounter = 0;
        this.__addSymbolStruct(symbolStruct);
        return this.__dependencyDeferred.promise;
    },

    /**
     * @param symbolStruct
     * @private
     */
    __addSymbolStruct: function(symbolStruct) {
        ++this.__depencencyCounter;
        if (this.__includedIds[symbolStruct.id]) {
            this.__decDependencyCounter();
            return;
        }
        this.__includedIds[symbolStruct.id] = true;

        var symbolDependencies = {};

        var processDependencies = function(file, dependencies) {
            var ignoreSymbols = !file ? {} :
                _(symbolStruct.ignore[file]).map(this.__getSymbolStruct, this).indexBy('id').value();

            _.forOwn(dependencies, function(depType, symbol) {
                var curSymbolStruct = this.__getSymbolStruct(symbol, depType.indexOf('Optional') !== -1);

                if (curSymbolStruct && !ignoreSymbols[curSymbolStruct.id] && curSymbolStruct !== symbolStruct) {
                    this.__addSymbolStruct(curSymbolStruct);
                    if (depType.indexOf('follow') === 0) {
                        (this.__addDeps[curSymbolStruct.id] || (this.__addDeps[curSymbolStruct.id] = {})
                        )[symbolStruct.id] = depType.replace('follow', 'require');
                    }
                    else {
                        symbolDependencies[curSymbolStruct.id] = depType;
                    }
                }
            }, this);
        }.bind(this);

        var promise = Q.all(symbolStruct.analyze.map(function(file) {
            return new FileScanner(file, this.__symbolsMap, this.__packages, this.__target.options).getResult()
                .then(_.partial(processDependencies, file));
        }, this));

        if (symbolStruct.dependencies) {
            processDependencies(null, symbolStruct.dependencies);
        }

        promise
            .then(function() {
                this.__addSymbolStructToResults(symbolStruct, symbolDependencies);
                this.__decDependencyCounter();
            }.bind(this))
            .catch(function(error) {
                this.__dependencyDeferred.reject(error);
            }.bind(this));
    },

    /**
     * @param symbolStruct
     * @param dependencies
     * @private
     */
    __addSymbolStructToResults: function(symbolStruct, dependencies) {
        if (program.dependencies) {
            console.log(symbolStruct.files,
                Object.keys(dependencies).map(function(x) { return this.__symbols[x].files; }, this));
        }
        var result = this.__resultsHash[symbolStruct.id] = {
            struct: symbolStruct,

            requireWeight: function(symbolsChain) {
                if (!symbolsChain) {
                    symbolsChain = [symbolStruct];
                }
                if (result._reqWeight) {
                    return result._reqWeight;
                }

                var weight = 1;
                result._calcReqWeight = true;
                _.assign(dependencies, this.__addDeps[symbolStruct.id]);
                _.forOwn(dependencies, function(depType, symbolStructId) {
                    if (depType === 'require' || depType === 'requireOptional') {
                        var reqResult = this.__resultsHash[symbolStructId];
                        if (!reqResult) {
                            return;
                        }

                        var curSymbolsChain = [this.__symbols[symbolStructId]].concat(symbolsChain);
                        if (reqResult._calcReqWeight) {
                            throw new Error('Cycle require dependency:\n' + curSymbolsChain.map(function(x) {
                                return JSON.stringify(x);
                            }).join('\n'));
                        }

                        var reqWeight = reqResult.requireWeight(curSymbolsChain);
                        if (reqWeight >= weight) {
                            weight = reqWeight + 1;
                        }
                    }
                }, this);
                result._calcReqWeight = false;

                result._reqWeight = weight;
                return weight;
            }.bind(this),

            useWeight: function() {
                if (result._useWeight) {
                    return result._useWeight;
                }

                var weight = 1;
                result._calcUseWeight = true;
                _.forOwn(dependencies, function(depType, symbolStructId) {
                    if (depType === 'use' || depType === 'useOptional') {
                        var useResult = this.__resultsHash[symbolStructId];
                        if (!useResult) {
                            return;
                        }

                        if (useResult._calcUseWeight) {
                            return;
                        }

                        var useWeight = useResult.useWeight();
                        if (useWeight >= weight) {
                            weight = useWeight + 1;
                        }
                    }
                }, this);
                result._calcUseWeight = false;

                result._useWeight = weight;
                return weight;
            }.bind(this)
        };
    },

    /**
     * @private
     */
    __decDependencyCounter: function() {
        --this.__depencencyCounter;
        if (this.__depencencyCounter === 0) {

            this.__finishTargetChunk();
            this.__dependencyDeferred.resolve();
        }
    },

    /**
     * @private
     */
    __findPackages: function() {
        this.__packages = {};
        _.forOwn(this.__symbolsHash, function(symbolDesc, symbol) {
            //todo вынести дополнительные типы в конфиг
            if (_.contains(symbolDesc.types, 'js') || _.contains(symbolDesc.types, 'coffee')) {
                this.__packages[symbol.split('.')[0]] = true;
            }
        }, this);
    },

    /**
     * @private
     */
    __finishTargetChunk: function() {
        //sort symbols
        var results = _.values(this.__resultsHash).sort(function(a, b) {
            var aReqWeight = a.requireWeight();
            var aUseWeight = a.useWeight();
            var bReqWeight = b.requireWeight();
            var bUseWeight = b.useWeight();
            var aFile = a.struct.files[0];
            var bFile = b.struct.files[0];

            return aReqWeight !== bReqWeight ? aReqWeight - bReqWeight :
                aUseWeight !== bUseWeight ? aUseWeight - bUseWeight :
                    aFile && bFile ? aFile.localeCompare(bFile) : 0;
        });

        //get files
        var resultFiles = _.flatten(results.map(function(result) {
            return result.struct.files.filter(function(file) {
                if (!this.__ignoreFiles[file]) {
                    this.__ignoreFiles[file] = true;
                    return program.separate || program.alltypes || path.extname(file) === '.js';
                }
                return false;
            }, this);
        }, this));

        this.__filesList = this.__filesList.concat(resultFiles);
    },

    /**
     * @param {string} symbolOrFile
     * @param {boolean} [optional=false]
     * @returns {Object}
     * @private
     */
    __getSymbolStruct: function(symbolOrFile, optional) {
        var symbolStruct = this.__symbolsHash[symbolOrFile];
        if (!symbolStruct) {
            symbolOrFile = library.normalizePath(this.__target, symbolOrFile);
            symbolStruct = this.__filesHash[symbolOrFile];
        }
        if (!symbolStruct && !optional) {
            var id = --lastSymbolId;
            var symbol = 'generated' + (-id);
            symbolStruct = this.__filesHash[symbolOrFile] = this.__symbolsHash[symbol] = this.__symbols[id] = {
                id: id,
                files: [symbolOrFile],
                symbols: [symbol],
                types: ['other'],
                analyze: [symbolOrFile],
                weight: {},
                ignore: {},
                dependencies: {}
            };
            symbolStruct.weight[symbolOrFile] = 0;
            symbolStruct.ignore[symbolOrFile] = [];
        }

        return symbolStruct;
    }
};

module.exports = DependenciesCalculator;