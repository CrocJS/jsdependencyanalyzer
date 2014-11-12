"use strict";

var path = require('path');
var fs = require('fs');

var crypto = require('crypto');
var Q = require('q');
var _ = require('lodash');
var program = require('commander');
var mkdirp = require('mkdirp');

var cache = {
    __cache: {},
    __newCache: {},
    __onRestore: [],
    __files: {},

    /**
     * Очистить кеш
     */
    clear: function() {
        if (program.nocache) {
            return;
        }

        try {
            fs.unlinkSync(this.__getFileName());
        }
        catch (ex) {
            if (ex.code !== 'ENOENT') {
                throw ex;
            }
        }
        this.__cacheCleared = true;
    },

    /**
     * Возвращает данные из кеша для файла
     * @param {string} section
     * @param {string} file
     * @param [defaults] данные по-умолчанию
     * @returns {*}
     */
    getData: function(section, file, defaults) {
        var sectionData = this.__cache[section] || (this.__cache[section] = {});
        var newSectionData = this.__newCache[section] || (this.__newCache[section] = {});

        if (section.indexOf(':') === 0) {
            return newSectionData[file] = sectionData[file];
        }

        if (!(file in sectionData) || this.__wasFileChanged(file)) {
            sectionData[file] = defaults;
        }
        this.__files[file] = true;
        return newSectionData[file] = sectionData[file];
    },

    /**
     * Возвращает все данные для секции
     * @param {string} section
     * @returns {*}
     */
    getDataSection: function(section) {
        return this.__cache[section];
    },

    /**
     * Удалить кеш полностью
     */
    invalidate: function() {
        this.__cache = {};
        this.__files = {};
    },

    /**
     * Выполнить callback после восстановления кеша
     * @param {function} callback
     */
    onRestore: function(callback) {
        if (this.__restored) {
            callback();
        }
        else {
            this.__onRestore.push(callback);
        }
    },

    /**
     * Удалить данные для секции
     * @param {string} section
     */
    removeDataSection: function(section) {
        delete this.__cache[section];
    },

    /**
     * Восстановить кеш (после сохранения)
     * @returns {Q.promise}
     */
    restore: function() {
        var promise;
        this.__restored = true;

        var fileName = this.__getFileName();
        if (!fs.existsSync(fileName)) {
            promise = Q();
        }
        else {
            promise = Q.denodeify(fs.readFile)(fileName)
                .then(function(data) {
                    data = JSON.parse(data);
                    if (data.files[program.confPath] === fs.statSync(program.confPath).mtime.getTime()) {
                        this.__cache = data.cache;
                        this.__files = data.files;
                    }
                }.bind(this));
        }

        return promise.then(function() {
            _.invoke(this.__onRestore, 'call', global);
        }.bind(this));
    },

    /**
     * Сохранить кеш в файл
     * @returns {Q.promise}
     */
    save: function() {
        if (this.__cacheCleared) {
            return Q();
        }

        var data = {
            cache: this.__newCache
        };

        if (!program.dirChangeInfo) {
            data.files = _(this.__newCache)
                .pick(function(data, section) {
                    return section.indexOf(':') !== 0;
                })
                .values().map(_.keys).flatten().uniq()
                .map(function(file) {
                    return [file, fs.statSync(file).mtime.getTime()];
                }, this)
                .zipObject()
                .value();
        }
        else {
            data.files = {};
        }

        data.files[program.confPath] = fs.statSync(program.confPath).mtime.getTime();

        var fileName = this.__getFileName();
        return Q.denodeify(mkdirp)(path.dirname(fileName), {mode: parseInt('777', 8)})
            .then(function() {
                return Q.denodeify(fs.writeFile)(fileName, JSON.stringify(data));
            });
    },

    /**
     * Задать данные кеша для файла
     * @param {string} section
     * @param {string} file
     * @param data
     * @returns {*}
     */
    setData: function(section, file, data) {
        var sectionData = this.__cache[section] || (this.__cache[section] = {});
        var newSectionData = this.__newCache[section] || (this.__newCache[section] = {});

        newSectionData[file] = sectionData[file] = data;
        if (section.indexOf(':') !== 0) {
            this.__files[file] = true;
        }
        return data;
    },

    /**
     * @param file
     * @returns {boolean}
     * @private
     */
    __wasFileChanged: function(file) {
        if (this.__files[file] === true) {
            return false;
        }
        var result = program.changed ?
        program.changed.indexOf(file) !== -1 :
        !this.__files[file] || this.__files[file] !== fs.statSync(file).mtime.getTime();

        if (!result) {
            this.__files[file] = true;
        }

        return result;
    },

    /**
     * @returns {*}
     * @private
     */
    __getFileName: function() {
        if (!this.__fileName) {
            var hash = crypto.createHash('md5');
            hash.update(_.flatten([program.confPath, program.target, program.only, program.add]).join(' '));
            this.__fileName = path.join(program.cache, hash.digest('hex'));
        }

        return this.__fileName;
    }
};

module.exports = cache;