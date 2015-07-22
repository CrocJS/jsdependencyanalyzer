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
    useOptional: 0,
    require: 1,
    requireOptional: 1,
    follow: 1,
    followOptional: 1,
    ignore: 2
};
var scriptRegexp = /<script(?: type="text\/javascript")?>([\s\S]*?)<\/script>/g;
var phpIncludeRegexp = /\b(?:include|require)(?:_once)?\s*(?:\(\s*)?(?:(?:__DIR__|dirname\(__FILE__\)|(dirname\(__DIR__\)))\s*\.\s*)?['"]([\w\d\/_\-\.]+)['"]\s*(?:\)\s*)?(?:;|\?>)( ?\/\/jsdep:ignore)?/g;
var commentRegexp = new RegExp(
    '(?:/[/*]|<!--) ?\\+(' + Object.keys(dependencyTypes).join('|') + ') (.+?) ?(?:\\*/|-->)?(?:\\r?\\n|$)', 'g');

/**
 * Сканирует файл на наличие в нём символов
 * @param {string} file
 * @param {Object} symbolsMap
 * @param {Object} packages
 * @param {Object} options
 * @constructor
 */
var FileScanner = function(file, symbolsMap, packages, options) {
    this.__file = file;
    this.__symbolsMap = symbolsMap;
    this.__packages = packages;
    this.__rawSymbols = [];
    this.__symbols = {};
    this.__options = options;
    
    if (program.missfile && !fs.existsSync(file)) {
        this.__result = Q({});
        return;
    }
    
    this.__result = Q()
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
                    //this.__rawSymbols.push = function(symbol) {
                    //    if (symbol.symbol === 'b-sbutton set_system mod_main') {
                    //        console.trace();
                    //        process.exit();
                    //    }
                    //    return Array.prototype.push.apply(this, arguments);
                    //};
                    this.__scanFile(content, this.__file);
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
        
        .then(function() {
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
};

FileScanner.prototype = {
    constructor: FileScanner,
    
    /**
     * Результат работы компонента
     * @returns {Q}
     */
    getResult: function() {
        return this.__result;
    },
    
    /**
     * @param {boolean} options
     * @param {string} options.symbol
     * @param [options.depType]
     * @param [options.wildcard = false]
     * @param [options.meta]
     */
    __addDependency: function(options) {
        var symbol = options.symbol;
        var depType = options.depType;
        if (options.wildcard && symbol[symbol.length - 1] === '*' && symbol[symbol.length - 2] === '.') {
            var prefix = symbol.substr(0, symbol.length - 1);
            _.forOwn(this.__symbolsMap.symbolsHash, function(value, name) {
                if (name.substr(0, prefix.length) === prefix) {
                    this.__addDependency({symbol: name, depType: depType, meta: options.meta});
                }
            }, this);
        }
        else {
            var curSymbolType = this.__symbols[symbol];
            if (!curSymbolType || dependencyTypes[curSymbolType] < dependencyTypes[depType]) {
                this.__symbols[symbol] = options.meta ? {depType: depType, meta: options.meta} : depType;
            }
        }
    },
    
    /**
     * @param struct
     * @returns {*}
     * @private
     */
    __composeSymbol: function(struct) {
        var operand = this.__getOperand(struct);
        
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
                useSymbol = !this.__requireAll && this.__getOperand(struct) === 'function';
            }
            struct.forEach(function(subStruct) {
                this.__findSymbols(subStruct, useSymbol);
            }, this);
        }
    },
    
    /**
     * @param struct
     * @returns {string}
     * @private
     */
    __getOperand: function(struct) {
        return struct === null ? 'null' :
            typeof struct === 'string' ? 'string' :
                !Array.isArray(struct) ? 'token' :
                    !struct.length || Array.isArray(struct[0]) || !struct[0] ? 'nope' :
                        typeof struct[0] === 'string' ? struct[0] : struct[0].name;
    },
    
    /**
     * @param text
     * @private
     */
    __parseComments: function(text) {
        var match;
        while (match = commentRegexp.exec(text)) { // jshint ignore:line
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
    
    /**
     * @param {string} content
     * @param {boolean} [suppressErrors=false]
     * @private
     */
    __parseJS: function(content, suppressErrors) {
        var parsedJS;
        if (suppressErrors) {
            try {
                parsedJS = parsejs.parse(content, false, true);
            }
            catch (ex) {
            }
        }
        else {
            parsedJS = parsejs.parse(content, false, true);
        }
        
        if (parsedJS) {
            this.__findSymbols(parsedJS, false);
        }
    },
    
    /**
     * @private
     */
    __processRawSymbols: function() {
        this.__rawSymbols.forEach(function(symbolDesc) {
            if (Array.isArray(symbolDesc.symbol)) {
                var symbol = symbolDesc.symbol.concat();
                if (this.__packages[symbol[0]]) {
                    while (symbol.length) {
                        var curSymbol = symbol.join('.');
                        if (this.__symbolsMap.symbolsHash[curSymbol]) {
                            this.__addDependency({symbol: curSymbol, depType: symbolDesc.depType});
                        }
                        symbol.pop();
                    }
                }
            }
            else {
                this.__addDependency(symbolDesc);
            }
        }, this);
    },
    
    /**
     * @param {string} content
     * @param {string} [filePath]
     * @private
     */
    __scanFile: function(content, filePath) {
        var extName = filePath && path.extname(filePath);
        var isInlineJs = !extName;
        var isPhp = extName === '.php';
        var isTpl = !isInlineJs && extName !== '.js' && extName !== '.css';
        var isJs = extName === '.js';
        
        if (path.basename(filePath) === '.bower.json') {
            var bower = JSON.parse(content);
            if (bower.dependencies) {
                _.forOwn(bower.dependencies, function(version, dep) {
                    this.__rawSymbols.push({
                        symbol: 'bower:' + dep,
                        depType: 'require'
                    });
                }, this);
            }
            (Array.isArray(bower.main) ? bower.main : [bower.main]).forEach(function(include) {
                if (path.extname(include) === '.js') {
                    this.__rawSymbols.push({
                        symbol: '!!' + path.join(path.dirname(filePath), include),
                        meta: {bower: true},
                        depType: 'follow'
                    });
                }
            }, this);
            return;
        }
        
        if (extName === '.coffee') {
            var coffeeCompiler = require('iced-coffee-script').compile;
            content = coffeeCompiler(content, {bare: true});
            isJs = true;
        }
        
        if (isTpl && (content.indexOf('<?php //+ignore') === 0 || content.indexOf('<?php /*+ignore*/') === 0)) {
            return;
        }
        
        if (!isInlineJs) {
            this.__parseComments(content);
        }
        
        if (isTpl || isJs) {
            this.__scanMatches(content, this.__options.htmlSymbolRegexp, this.__options.htmlSymbolsMap);
            
            //scan css
            var cssHash = this.__symbolsMap.typesHash.css;
            if (cssHash) {
                var classes = Object.keys(cssHash).filter(function(cls){ return cls.indexOf('.') === -1; });
                var cssRe = new RegExp('\\b(?:' + classes.join('|') + ')(?![\\d\\w\\-_])', 'g');
                var cssMatch = content.match(cssRe);
                if (cssMatch) {
                    cssMatch.forEach(function(symbol) {
                        this.__rawSymbols.push({symbol: symbol, depType: 'use'});
                    }, this);
                }
            }
        }
        
        if (isJs) {
            this.__scanMatches(content, this.__options.jsSymbolRegexp, this.__options.jsSymbolsMap);
        }
        
        if (isJs || isInlineJs) {
            this.__parseJS(content, isInlineJs);
        }
        
        if (isTpl) {
            var scriptMatch;
            while (scriptMatch = scriptRegexp.exec(content)) { // jshint ignore:line
                this.__scanFile(scriptMatch[1]);
            }
            if (this.__options.tplJs) {
                this.__options.tplJs.forEach(function(func) {
                    var code = func(content);
                    if (code) {
                        this.__parseJS(content, true);
                    }
                }, this);
            }
        }
        
        if (isPhp) {
            var includeMatch;
            while (includeMatch = phpIncludeRegexp.exec(content)) { // jshint ignore:line
                if (!includeMatch[3]) {
                    //!! - absolute path
                    var dir = path.dirname(filePath);
                    if (includeMatch[1]) {
                        dir = path.dirname(dir);
                    }
                    this.__rawSymbols.push({
                        symbol: '!!' + path.join(dir, includeMatch[2]),
                        depType: 'use'
                    });
                }
            }
        }
    },
    
    /**
     * @param {string} source
     * @param {RegExp} regexp
     * @param {Object} map
     * @private
     */
    __scanMatches: function(source, regexp, map) {
        if (regexp) {
            if (!Array.isArray(regexp)) {
                regexp = [regexp];
            }
            regexp.forEach(function(re) {
                if (re instanceof RegExp) {
                    re = {
                        re: re, symbol: function(match) {
                            return match[1];
                        }
                    };
                }
                var match;
                while (match = re.re.exec(source)) { // jshint ignore:line
                    this.__rawSymbols.push({symbol: re.symbol.call(this.__options, match), depType: 'use'});
                }
            }, this);
        }
        
        if (map) {
            _.forOwn(map, function(symbol, pattern) {
                if (source.indexOf(pattern) !== -1) {
                    (Array.isArray(symbol) ? symbol : [symbol]).forEach(function(curSymbol) {
                        this.__rawSymbols.push({symbol: curSymbol, depType: 'use'});
                    }, this);
                }
            }, this);
        }
    }
};

module.exports = FileScanner;