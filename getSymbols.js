"use strict";

var fs = require('fs');
var path = require('path');

var Q = require('q');
var _ = require('lodash');
var program = require('commander');

var parsejs = require('./parse-js');
var cache = require('./cache');

var readFile = Q.denodeify(fs.readFile);

var symbolsCache = 'symbols';
var processedSymbolsCache = 'processedSymbols';
var rawSymbolsDef = {};

var dependencyTypes = {
    use: 0,
    require: 1,
    ignore: 2
};
var scriptRegexp = /<script(?: type="text\/javascript")?>([\s\S]*?)<\/script>/g;
var phpIncludeRegexp = /\b(?:include|require)(?:_once)?\s*(?:\(\s*)?(?:(?:__DIR__|dirname\(__FILE__\))\s*\.\s*)?['"]([\w\d\/_\-\.]+)['"]\s*(?:\)\s*)?(?:;|\?>)( ?\/\/jsdep:ignore)?/g;
var commentRegexp = new RegExp('//\\+(' + Object.keys(dependencyTypes).join('|') + ') (.+)', 'g');

function getOperand(struct) {
    return struct === null ? 'null' :
        typeof struct === 'string' ? 'string' :
            !Array.isArray(struct) ? 'token' :
                !struct.length || Array.isArray(struct[0]) || !struct[0] ? 'nope' :
                    typeof struct[0] === 'string' ? struct[0] : struct[0].name;
}

/**
 * @param file
 * @param existedSymbols
 * @param packages
 * @param options
 * @constructor
 */
var Parser = function(file, existedSymbols, packages, options) {
    this.__file = file;
    this.__existedSymbols = existedSymbols;
    this.__packages = packages;
    this.__rawSymbols = [];
    this.__symbols = {};
    this.__options = options;
};

Parser.prototype = {
    constructor: Parser,

    /**
     * @param {string} symbol
     * @param [dependencyType]
     * @param [checkWildcard = false]
     */
    addDependency: function(symbol, dependencyType, checkWildcard) {
        if (checkWildcard && symbol[symbol.length - 1] === '*' && symbol[symbol.length - 2] === '.') {
            var prefix = symbol.substr(0, symbol.length - 1);
            _.forOwn(this.__existedSymbols, function(value, name) {
                if (name.substr(0, prefix.length) === prefix) {
                    this.addDependency(name, dependencyType);
                }
            }, this);
        }
        else {
            var curSymbolType = this.__symbols[symbol];
            if (!curSymbolType || dependencyTypes[curSymbolType] < dependencyTypes[dependencyType]) {
                this.__symbols[symbol] = dependencyType;
            }
        }
    },

    /**
     * @returns {Q}
     */
    parse: function() {

        return Q()
            .then(function() {
                var fromCache = cache.getData(symbolsCache, this.__file);
                if (fromCache) {
                    this.__rawSymbols = fromCache;
                    return;
                }
                else if (rawSymbolsDef[this.__file]) {
                    return rawSymbolsDef[this.__file].then(function(symbols) {
                        this.__rawSymbols = symbols;
                    }.bind(this));
                }

                var promise = readFile(this.__file, 'utf8').then(
                    function(content) {
                        if (path.extname(this.__file) !== '.js') {
                            this.__scanHTML(content, this.__file);
                        }
                        else {
                            this.__scanJS(content);
                        }
                    }.bind(this),

                    function() {
                        throw new Error('Read file error: ' + this.__file);
                    }.bind(this));

                return rawSymbolsDef[this.__file] = promise.then(function() {
                    delete rawSymbolsDef[this.__file];
                    cache.setData(symbolsCache, this.__file, this.__rawSymbols);
                    return this.__rawSymbols;
                }.bind(this));
            }.bind(this))
            .then(
                function() {
                    var fromCache = program.nodirchange && cache.getData(processedSymbolsCache, this.__file);
                    if (fromCache) {
                        this.__symbols = fromCache;
                    }
                    else {
                        this.__processRawSymbols();
                        _.forOwn(this.__symbols, function(depType, symbol) {
                            if (depType === 'ignore') {
                                delete this.__symbols[symbol];
                            }
                        }, this);
                    }

                    cache.setData(processedSymbolsCache, this.__file, this.__symbols);

                    return this.__symbols;
                }.bind(this));
    },

    /**
     * @param struct
     * @returns {*}
     * @private
     */
    __composeSymbol: function(struct) {
        var operand = getOperand(struct);

        if (operand === 'name') {
            return [struct[1]];
        }
        else if (operand === 'dot') {
            var prefix = this.__composeSymbol(struct[1]);
            return prefix && prefix.concat(struct[2]);
        }
        return false;
    },

    /**
     * @param struct
     * @param [useSymbol=false]
     * @private
     */
    __findSymbols: function(struct, useSymbol) {
        if (!Array.isArray(struct)) {
            return;
        }

        var symbol = this.__composeSymbol(struct);
        if (symbol) {
            this.__rawSymbols.push({symbol: symbol, depType: useSymbol ? 'use' : 'require'});
        }
        else {
            if (!useSymbol) {
                useSymbol = !this.__requireAll && getOperand(struct) === 'function';
            }
            struct.forEach(function(subStruct) {
                this.__findSymbols(subStruct, useSymbol);
            }, this);
        }
    },

    /**
     * @param text
     * @private
     */
    __parseComments: function(text) {
        var match;
        while (match = commentRegexp.exec(text)) {
            if (match) {
                if (match[1] === 'require' && match[2] === 'all') {
                    this.__requireAll = true;
                }
                else {
                    this.__rawSymbols.push({symbol: match[2], depType: match[1], wildcard: true});
                }
            }
        }
    },

    __processRawSymbols: function() {
        this.__rawSymbols.forEach(function(symbolDesc) {
            if (Array.isArray(symbolDesc.symbol)) {
                var symbol = symbolDesc.symbol.concat();
                if (this.__packages[symbol[0]]) {
                    while (symbol.length) {
                        var curSymbol = symbol.join('.');
                        if (this.__existedSymbols[curSymbol]) {
                            this.addDependency(curSymbol, symbolDesc.depType);
                        }
                        symbol.pop();
                    }
                }
            }
            else {
                this.addDependency(symbolDesc.symbol, symbolDesc.depType, symbolDesc.wildcard);
            }
        }, this);
    },

    __scanHTML: function(html, filePath) {
        if (html.indexOf('<?php //+ignore') === 0) {
            return;
        }

        this.__parseComments(html);

        var symRe = this.__options.htmlSymbolRegexp;
        if (symRe) {
            if (!Array.isArray(symRe)) {
                symRe = [symRe];
            }
            symRe.forEach(function(re) {
                if (re instanceof RegExp) {
                    re = {re: re, symbol: function(match) {
                        return match[1];
                    }}
                }
                var match;
                while (match = re.re.exec(html)) {
                    this.__rawSymbols.push({symbol: re.symbol(match), depType: 'use'});
                }
            }, this);
        }

        if (this.__options.htmlSymbolsMap) {
            _.forOwn(this.__options.htmlSymbolsMap, function(symbol, pattern) {
                if (html.indexOf(pattern) !== -1) {
                    (Array.isArray(symbol) ? symbol : [symbol]).forEach(function(curSymbol) {
                        this.__rawSymbols.push({symbol: curSymbol, depType: 'use'});
                    }, this);
                }
            }, this);
        }

        var scriptMatch;
        while (scriptMatch = scriptRegexp.exec(html)) {
            this.__scanJS(scriptMatch[1], true);
        }

        var includeMatch;
        while (includeMatch = phpIncludeRegexp.exec(html)) {
            if (!includeMatch[2]) {
                //!! - absolute path
                this.__rawSymbols.push({
                    symbol: '!!' + path.join(path.dirname(filePath), includeMatch[1]),
                    depType: 'use'
                });
            }
        }
    },

    __scanJS: function(js, suppressErrors) {
        var parsedJS;
        if (suppressErrors) {
            try {
                parsedJS = parsejs.parse(js, false, true);
            }
            catch (ex) {
            }
        }
        else {
            parsedJS = parsejs.parse(js, false, true);
        }

        this.__parseComments(js);
        if (parsedJS) {
            this.__findSymbols(parsedJS, false);
        }

        var symRe = this.__options.jsSymbolRegexp;
        if (symRe) {
            if (!Array.isArray(symRe)) {
                symRe = [symRe];
            }
            symRe.forEach(function(re) {
                if (re instanceof RegExp) {
                    re = {re: re, symbol: function(match) {
                        return match[1];
                    }}
                }
                var match;
                while (match = re.re.exec(js)) {
                    this.__rawSymbols.push({symbol: re.symbol(match), depType: 'use'});
                }
            }, this);
        }
    }
};

/**
 * @param file
 * @param existedSymbols
 * @param packages
 * @param options
 * @returns {Q}
 */
exports.parse = function parseSymbols(file, existedSymbols, packages, options) {
    return new Parser(file, existedSymbols, packages, options).parse();
};