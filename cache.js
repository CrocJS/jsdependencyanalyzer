var path = require('path');
var fs = require('fs');

var crypto = require('crypto');
var Q = require('q');
var _ = require('lodash');
var program = require('commander');

module.exports = {
    __cache: {},
    __newCache: {},
    __files: {},
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
                else if (!program.nodirchange) {
                    delete this.__cache[':glob'];
                }
            }
        }.bind(this));
    },
    save: function() {
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

        var fileName = this.__getFileName();
        var dirName = path.dirname(fileName);
        if (!fs.existsSync(dirName)) {
            fs.mkdirSync(dirName);
        }

        data.files[program.confPath] = fs.statSync(program.confPath).mtime.getTime();
        return Q.denodeify(fs.writeFile)(fileName, JSON.stringify(data));
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
        if (this.__fileName) {
            return this.__fileName;
        }

        var hash = crypto.createHash('md5');
        hash.update(_.flatten([program.confPath, program.target, program.only, program.add]).join(' '));
        return (this.__fileName = path.join(__dirname, 'cache/' + hash.digest('hex')));
    }
};
