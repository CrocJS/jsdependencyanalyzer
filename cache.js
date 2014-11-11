var path = require('path');
var fs = require('fs');

var crypto = require('crypto');
var Q = require('q');
var _ = require('lodash');
var program = require('commander');
var mkdirp = require('mkdirp');

module.exports = {
    __cache: {},
    __newCache: {},
    __files: {},
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
    getOldGlobCache: function() {
        return this.__oldGlobCache;
    },
    setData: function(section, file, data) {
        var sectionData = this.__cache[section] || (this.__cache[section] = {});
        var newSectionData = this.__newCache[section] || (this.__newCache[section] = {});

        newSectionData[file] = sectionData[file] = data;
        if (section.indexOf(':') !== 0) {
            this.__files[file] = true;
        }
        return data;
    },
    restore: function() {
        var fileName = this.__getFileName();
        if (!fs.existsSync(fileName)) {
            return Q();
        }
        return Q.denodeify(fs.readFile)(fileName).then(function(data) {
            data = JSON.parse(data);
            if (data.files[program.confPath] === fs.statSync(program.confPath).mtime.getTime()) {
                this.__cache = data.cache;
                this.__files = data.files;

                var globCache = this.__cache[':glob'];
                if (globCache && program.dirChangeInfo) {
                    if ((program.added.concat(program.removed))
                            .some(function(x) { return path.extname(x) === '.css'; })) {
                        this.invalidate();
                    }
                    else {
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
                    this.__oldGlobCache = this.__cache[':glob'];
                    delete this.__cache[':glob'];
                }
            }
        }.bind(this));
    },
    invalidate: function() {
        this.__cache = {};
        this.__files = {};
    },
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
        return Q.denodeify(mkdirp)(path.dirname(fileName), {mode: 0777})
            .then(function() {
                return Q.denodeify(fs.writeFile)(fileName, JSON.stringify(data));
            });
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
