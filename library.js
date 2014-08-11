"use strict";

var Q = require('q');
var path = require('path');
var program = require('commander');

module.exports = {
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

        var normalized = ((root === '' || root) ? path.resolve(root, path_) : path.normalize(path_)).replace(/[\\\/]+/g, '/');
        if (addSlash && normalized[normalized.length - 1] !== '/') {
            normalized += '/';
        }
        return normalized;
    }
};