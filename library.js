"use strict";

var Q = require('q');
var path = require('path');
var program = require('commander');
var _ = require('lodash');

module.exports = {
    /**
     * @param target
     * @param basePath
     * @param sources
     */
    addSources: function(target, basePath, sources) {
        function getPath(path_) {
            return path_[0] === '/' || path_[0] === '!' ? path_ : '!' + path.join(basePath, path_);
        }
        
        target.sources = (target.sources || (target.sources = [])).concat(sources.map(function(source) {
            source = _.clone(source);
            if (source.file) {
                if (!Array.isArray(source.file)) {
                    source.file = [source.file];
                }
                source.file = source.file.map(getPath);
            }
            if (source.path) {
                if (typeof source.path === 'string') {
                    source.path = getPath(source.path);
                }
                else {
                    source.path = _(source.path)
                        .map(function(key, value) { return [getPath(key), value]; })
                        .zipObject().value();
                }
            }
            return source;
        }));
    },
    
    /**
     * @param target
     * @param file
     * @returns {string}
     */
    finalizePath: function(target, file) {
        if (!program.abspath && (target.site === '' || target.site)) {
            file = this.normalizePath(null, path.relative(path.resolve(program.path, target.site), file));
            if (target.siteAbsolute) {
                file = '/' + file;
            }
        }
        return file;
    },
    
    /**
     * @param target
     * @param path_
     * @param [addSlash=false]
     * @returns {string}
     */
    normalizePath: function(target, path_, addSlash) {
        if (path_.indexOf('!!') === 0) {
            path_ = '/' + path.relative(target.root, path_.substr(2));
        }
        var root = target ? (path_.indexOf('/') === 0 ? target.root : target.js) : null;
        if ((root === '' || root) && path_.indexOf('/') === 0) {
            path_ = path_.substr(1);
        }
        
        var normalized = ((root === '' || root) ? path.resolve(root, path_) : path.normalize(path_))
            .replace(/[\\\/]+/g, '/');
        if (addSlash && normalized[normalized.length - 1] !== '/') {
            normalized += '/';
        }
        return normalized;
    }
};