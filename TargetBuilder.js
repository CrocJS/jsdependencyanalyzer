"use strict";

var path = require('path');

var program = require('commander');
var _ = require('lodash');
var Q = require('q');

var library = require('./library');
var DependenciesCalculator = require('./DependenciesCalculator');

/**
 * Компонент для сборки переданной цели
 * @param {Object} targets
 * @constructor
 */
var TargetBuilder = function(targets) {
    this.__targets = targets;
};

TargetBuilder.prototype = {
    constructor: TargetBuilder,
    
    build: function(targetName) {
        if (!this.__targets[targetName]) {
            throw new Error('No such target: ' + targetName);
        }
        var target = this.resolveTarget(this.__targets[targetName]);
        if (program.only) {
            target.packages = _.pick(target.packages, program.only);
            if (_.isEmpty(target.packages)) {
                throw new Error('No such package "' + program.only + '" in target "' + targetName + '"');
            }
        }
        
        return this.__buildRaw(target, null, program.add ? [program.add] : null)
            .then(function(result) {
                result.target = targetName;
                if (result.files) {
                    result.files = result.files.map(function(file) {
                        return library.finalizePath(target, file);
                    });
                }
                if (result.packages) {
                    result.packages = _.mapValues(result.packages, function(files) {
                        return files.map(function(file) {
                            return library.finalizePath(target, file);
                        });
                    });
                }
                if (program.separate) {
                    var separateFiles = function(files) {
                        return _.groupBy(files, function(file) {
                            return path.extname(file).slice(1);
                        });
                    };
                    if (result.files) {
                        result.files = separateFiles(result.files);
                    }
                    if (result.packages) {
                        result.packages = _.mapValues(result.packages, separateFiles);
                    }
                }
                
                return result;
            });
    },
    
    /**
     * @param {Array.<string>} names
     * @returns {Array.<Object>}
     */
    flattenTargets: function(names) {
        return _(names)
            .map(function(name) {
                return this.__targets[name] && this.__targets[name].run ? this.__targets[name].run : name;
            }, this)
            .flatten()
            .value();
    },
    
    /**
     * @param {Object} target
     * @param {boolean} [isPackage=false]
     * @returns {*}
     */
    resolveTarget: function(target, isPackage) {
        if (target.ready) {
            return target;
        }
        
        if ('site' in target) {
            target.site = path.resolve(program.path, target.site);
        }
        if ('js' in target) {
            target.js = path.resolve(program.path, target.js);
        }
        if ('root' in target) {
            target.root = path.resolve(program.path, target.root);
        }
        
        if (target.extend) {
            var parentTarget = typeof target.extend === 'string' ?
                this.resolveTarget(this.__targets[target.extend]) : target.extend;
            
            _.forOwn(parentTarget, function(value, key) {
                if (key === 'extend' || key === 'external' || key === 'ready' ||
                    isPackage && (key === 'packages' || key === 'include')) {
                    return;
                }
                if (key === 'sources' || key === 'include') {
                    target[key] = target[key] ? value.concat(target[key]) : value;
                }
                else if (key === 'options' || key === 'packages') {
                    target[key] = target[key] ? _.assign(_.clone(value), target[key]) : _.clone(value);
                }
                else if (!(key in target)) {
                    target[key] = value;
                }
            });
        }
        
        if (!target.root) {
            target.root = program.path;
        }
        if (!target.options) {
            target.options = {};
        }
        if (!target.sources) {
            target.sources = [];
        }
        
        this.__includeExternals(target);
        
        if (target.packages) {
            _.forOwn(target.packages, function(pack) {
                if (!pack.ready) {
                    pack.extend = target;
                    this.resolveTarget(pack, true);
                }
            }, this);
        }
        
        target.ready = true;
        return target;
    },
    
    /**
     * Собрать цель
     * @param {Object} target
     * @param {Array.<string>} [ignoreFiles]
     * @param {Array.<string>} [addSymbols]
     * @constructor
     */
    __buildRaw: function(target, ignoreFiles, addSymbols) {
        if (typeof target === 'string') {
            target = this.__targets[target];
        }
        target = this.resolveTarget(target);
        
        var result = {filesHash: {}, targetObj: target};
        var promise = Q();
        if (target.include || addSymbols) {
            if (target.include) {
                target.include = _.flatten(target.include.map(function(dependency) {
                    return dependency.indexOf('target:') === 0 ?
                    this.resolveTarget(this.__targets[dependency.substr('target:'.length)]).include || [] : dependency;
                }, this));
            }
            
            if (addSymbols) {
                target.include = target.include ? target.include.concat(addSymbols) : addSymbols;
            }
            
            var depCalc = new DependenciesCalculator(target, ignoreFiles);
            promise = depCalc.getResult().then(function(files) {
                result.files = files;
                _.assign(result.filesHash, depCalc.getFilesHash());
            });
        }
        
        if (target.packages) {
            result.packages = {};
            promise = promise.then(function() {
                return Q.all(_.chain(target.packages).mapValues(function(pack, packageName) {
                    return this.__buildRaw(pack, result.files).then(function(packageResult) {
                        result.packages[packageName] = packageResult.files || [];
                        _.assign(result.filesHash, packageResult.filesHash);
                    });
                }, this).values().value());
            }.bind(this));
        }
        
        return promise.thenResolve(result);
    },
    
    /**
     * @param target
     * @private
     */
    __includeExternals: function(target) {
        if (target.external) {
            _.flatten(target.external).forEach(function(external) {
                external(target, library);
            });
        }
    }
};

module.exports = TargetBuilder;