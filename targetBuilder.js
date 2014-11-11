"use strict";

var path = require('path');

var Q = require('q');
var _ = require('lodash');
var program = require('commander');

var library = require('./library');
var getSymbols = require('./getSymbols');
var symbolsMap = require('./symbolsMap');

var lastSymbolId = 0;

var TargetBuilder = function(target, ignoreFiles) {
    this.__target = target;
    this.__ignoreFiles = {};
    if (ignoreFiles) {
        ignoreFiles.forEach(function(file) {
            this.__ignoreFiles[file] = true;
        }, this);
    }
};

TargetBuilder.prototype = {
    build: function() {
        return symbolsMap.create(_.pick(this.__target, 'js', 'root', 'sources'))
            .then(function(result) {
                this.__symbols = result.symbols;
                this.__filesHash = result.filesHash;
                this.__symbolsHash = result.symbolsHash;
                this.__symbolsMap = result;

                this.__findPackages();

                this.__includedIds = {};
                this.__filesList = [];

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
                    var aWeight = hash[a].weight;
                    var bWeight = hash[b].weight;
                    return aWeight === bWeight ? files.indexOf(a) - files.indexOf(b) : aWeight - bWeight;
                }.bind(this));
            }.bind(this));
    },

    __addTargetChunk: function(symbolStruct) {
        this.__dependencyDeferred = Q.defer();
        this.__resultsHash = {};
        this.__depencencyCounter = 0;
        this.__addSymbolStruct(symbolStruct);
        return this.__dependencyDeferred.promise;
    },

    __addSymbolStruct: function(symbolStruct) {
        ++this.__depencencyCounter;
        if (this.__includedIds[symbolStruct.id]) {
            this.__decDependencyCounter();
            return;
        }
        this.__includedIds[symbolStruct.id] = true;

        var symbolDependencies = {};
        var ignoreSymbols = !symbolStruct.ignore ? [] :
            symbolStruct.ignore.map(this.__getSymbolStruct, this).map(function(x) {return x.id;});

        var processDependencies = function(dependencies) {
            _.forOwn(dependencies, function(depType, symbol) {
                var curSymbolStruct = this.__getSymbolStruct(symbol);
                if (ignoreSymbols.indexOf(curSymbolStruct.id) === -1 && curSymbolStruct !== symbolStruct) {
                    symbolDependencies[curSymbolStruct.id] = depType;
                    this.__addSymbolStruct(curSymbolStruct);
                }
            }, this);
        }.bind(this);

        var promise = Q();
        if (symbolStruct.analyze) {
            promise = Q.all(symbolStruct.files.map(function(file) {
                return getSymbols.parse(file, this.__symbolsMap, this.__packages, this.__target.options)
                    .then(processDependencies);
            }, this));
        }

        if (symbolStruct.dependencies) {
            processDependencies(symbolStruct.dependencies);
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
                _.forOwn(dependencies, function(depType, symbolStructId) {
                    if (depType === 'require') {
                        var incResult = this.__resultsHash[symbolStructId];
                        if (!incResult) {
                            return;
                        }

                        var curSymbolsChain = [this.__symbols[symbolStructId]].concat(symbolsChain);
                        if (incResult._calcReqWeight) {
                            throw new Error('Cycle require dependency:\n' + curSymbolsChain.map(function(x) {
                                return JSON.stringify(x);
                            }).join('\n'));
                        }

                        var reqWeight = incResult.requireWeight(curSymbolsChain);
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
                    if (depType === 'use') {
                        var reqResult = this.__resultsHash[symbolStructId];
                        if (!reqResult) {
                            return;
                        }

                        if (reqResult._calcUseWeight) {
                            return;
                        }

                        var useWeight = reqResult.useWeight();
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
            if (symbolDesc.type === 'js') {
                this.__packages[symbol.split('.')[0]] = true;
            }
        }, this);
    },

    __finishTargetChunk: function() {
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

        var resultFiles = _.flatten(results.map(function(result) {
            return result.struct.files.filter(function(file) {
                if (!this.__ignoreFiles[file]) {
                    this.__ignoreFiles[file] = true;
                    return _.contains(['.js', '.css'], path.extname(file));
                }
                return false;
            }, this);
        }, this));

        this.__filesList = this.__filesList.concat(resultFiles);
    },

    __getSymbolStruct: function(symbolOrFile) {
        var symbolStruct = this.__symbolsHash[symbolOrFile];
        if (!symbolStruct) {
            symbolOrFile = library.normalizePath(this.__target, symbolOrFile);
            symbolStruct = this.__filesHash[symbolOrFile];
        }
        if (!symbolStruct) {
            var id = --lastSymbolId;
            var symbol = 'generated' + (-id);
            symbolStruct = this.__filesHash[symbolOrFile] = this.__symbolsHash[symbol] = this.__symbols[id] = {
                id: id,
                files: [symbolOrFile],
                symbols: [symbol],
                analyze: true,
                type: 'other',
                weight: 0
            };
        }

        return symbolStruct;
    }
};

exports.build = function(target, ignoreFiles) {
    return new TargetBuilder(target, ignoreFiles).build();
};