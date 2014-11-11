"use strict";

var path = require('path');
var fs = require('fs');
var program = require('commander');
var _ = require('lodash');
var Q = require('q');
var library = require('./library');
var targetBuilder = require('./targetBuilder');
var http = require('http');
var cache = require('./cache');
var mkdirp = require('mkdirp');

process.umask(parseInt('000', 8));

var commaSeparated = function(x) { return _.compact(x.split(',')); };

program
    .option('-p, --path [path]', 'Path to jsdep.js', path.resolve)
    .option('--cache [cache]', 'Path to cache directory', path.resolve, path.join(__dirname, 'cache'))
    .option('-t, --target [target]', 'Target(s) to build (separated by comma)', commaSeparated, ['current'])
    .option('-a, --add [add]', 'Add file or symbol')
    .option('-o, --only [only]', 'Build only one package in target')
    .option('-s, --statistics [statistics]', 'Statistics of file usage in packages')
    .option('-d, --dependencies [dependencies]', 'Print dependencies between files')
    .option('-e, --debug [debug]', 'Debug mode (print stack for errors)')
    .option('--separate', 'Group files by type')
    .option('--time', 'Print executing time')
    .option('--nocache', 'Build without cache')
    .option('--copyto [copyto]', 'Copy result files to folder')
    .option('--unused', 'Show unused js files')
    .option('--missfile', 'Ignore no file errors')
    .option('--nodirchange', 'Sources directories havn\'t changed')
    .option('--changed [changed]',
    'Sources files which have benn changed. Specify --changed= if there is no changed files.',
    commaSeparated)
    .option('--added [added]', 'Sources files which have benn added. Specify --added= if there is no added files.',
    commaSeparated)
    .option('--removed [removed]',
    'Sources files which have benn removed. Specify --removed= if there is no removed files.',
    commaSeparated)
    .parse(process.argv);

var defaultConfPath = !program.path;
if (defaultConfPath) {
    program.path = path.join(__dirname, 'jsdep.js');
}

if (program.added && program.removed) {
    program.dirChangeInfo = true;
}
if (!program.nodirchange && program.dirChangeInfo && !program.added.length && !program.removed.length) {
    program.nodirchange = true;
}

var timeStart;
if (program.time) {
    timeStart = program.timeStart = new Date().getTime();
}

var confPath = program.confPath = program.path;
program.path = path.dirname(program.path);

function processError(error) {
    if (program.debug) {
        if (error.stack) {
            error.stack.split('\n').forEach(function(line) {
                console.log(line);
            });
        }
        else {
            console.log(error);
        }
    }
    else {
        console.log('Error!\n' + error.message);
    }

    cache.clear();
}

process.on('uncaughtException', processError);

var config;
try {
    config = require(confPath);
}
catch (ex) {
    if (defaultConfPath) {
        program.help();
    }
    throw new Error('Corrupted config file: ' + confPath);
}

/**
 * @param target
 * @param [isPackage=false]
 * @returns {*}
 */
function resolveTarget(target, isPackage) {
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

    if (!target.extend) {
        target.ready = true;
        return target;
    }

    var parentTarget = typeof target.extend === 'string' ? resolveTarget(config[target.extend]) : target.extend;
    if ('root' in parentTarget && !('root' in target)) {
        target.root = parentTarget.root;
    }

    if ('site' in parentTarget && !('site' in target)) {
        target.site = parentTarget.site;
    }

    if ('js' in parentTarget && !('js' in target)) {
        target.js = parentTarget.js;
    }

    if (parentTarget.siteAbsolute && !('siteAbsolute' in target)) {
        target.siteAbsolute = parentTarget.siteAbsolute;
    }
    if (parentTarget.sources) {
        target.sources = target.sources ? parentTarget.sources.concat(target.sources) : parentTarget.sources;
    }
    if (parentTarget.include && !isPackage) {
        target.include = target.include ? parentTarget.include.concat(target.include) : parentTarget.include.concat();
    }

    if (parentTarget.options) {
        target.options = target.options ?
            _.assign(_.clone(parentTarget.options), target.options) :
            _.clone(parentTarget.options);
    }
    else if (!target.options) {
        target.options = {};
    }

    if (target.packages) {
        _.forOwn(target.packages, function(pack, packageName) {
            pack.extend = target;
            target.packages[packageName] = resolveTarget(pack, true);
        });
    }
    if (parentTarget.packages && !isPackage) {
        target.packages = _.assign(_.clone(parentTarget.packages), target.packages || {});
    }

    target.ready = true;
    return target;
}

function buildTarget(target, ignoreFiles, addSymbols) {
    target = resolveTarget(target);

    var result = {};
    var promise = Q();
    if (target.include || addSymbols) {
        if (target.include) {
            target.include = _.flatten(target.include.map(function(dependency) {
                return dependency.indexOf('target:') === 0 ?
                resolveTarget(config[dependency.substr('target:'.length)]).include || [] : dependency;
            }));
        }

        if (addSymbols) {
            target.include = target.include ? target.include.concat(addSymbols) : addSymbols;
        }

        promise = targetBuilder.build(target, ignoreFiles).then(function(files) {
            result.files = files;
        });
    }

    if (target.packages) {
        result.packages = {};
        promise = promise.then(function() {
            return Q.all(_.chain(target.packages).mapValues(function(pack, packageName) {
                return buildTarget(pack, result.files).then(function(packageResult) {
                    result.packages[packageName] = packageResult.files || [];
                });
            }).values().value());
        });
    }

    return promise.thenResolve(result);
}

function finalizePath(target, file) {
    if (target.site === '' || target.site) {
        file = library.normalizePath(null, path.relative(path.resolve(program.path, target.site), file));
        if (target.siteAbsolute) {
            file = '/' + file;
        }
    }
    return file;
}

//resolve "run" targets
program.target = _.flatten(
    program.target.map(function(target) {
        return config[target] && config[target].run ? config[target].run : target;
    })
);

//process program.added/removed
var sitePath = path.resolve(program.path, resolveTarget(config[program.target[0]]).site);
var getAbsPath = function(relPath) {
    return library.normalizePath(null,
        path.resolve(sitePath, relPath.indexOf('/') === 0 ? relPath.substr(1) : relPath));
};
if (program.dirChangeInfo) {
    program.added = program.added.map(getAbsPath);
    program.removed = program.removed.map(getAbsPath);
}
if (program.changed) {
    program.changed = program.changed.map(getAbsPath);
}

(program.nocache ? Q() : cache.restore())
    .then(function() {
        var targetsDeferreds = [];
        program.target.forEach(function(targetName) {
            if (!config[targetName]) {
                throw new Error('No such target: ' + targetName);
            }
            var target = resolveTarget(config[targetName]);
            if (program.only) {
                target.packages = _.pick(target.packages, program.only);
                if (_.isEmpty(target.packages)) {
                    throw new Error('No such package "' + program.only + '" in target "' + targetName + '"');
                }
            }
            targetsDeferreds.push(buildTarget(target, null, program.add ? [program.add] : null)
                .then(function(result) {
                    result.target = targetName;
                    if (result.files) {
                        result.files = result.files.map(finalizePath.bind(global, target));
                    }
                    if (result.packages) {
                        result.packages = _.mapValues(result.packages, function(files) {
                            return files.map(finalizePath.bind(global, target))
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
                }));
        });

        return Q.all(targetsDeferreds);
    })
    .then(function(results) {
        if (!program.time && !program.unused) {
            console.log(JSON.stringify(results.length > 1 ? results : results[0], null, 4));
        }

        if (program.statistics) {
            results.forEach(function(result) {
                console.log('\n');
                if (results.length > 1) {
                    console.log('target: ' + result.target);
                }

                console.log('statistics (' + _.size(result.packages) + ' packages)');
                var filesUsage = {};
                _.forOwn(result.packages, function(files) {
                    files.forEach(function(file) {
                        if (!filesUsage[file]) {
                            filesUsage[file] = 1;
                        }
                        else {
                            ++filesUsage[file];
                        }
                    });
                });

                _.pairs(filesUsage).sort(function(a, b) {
                    return b[1] - a[1];
                }).forEach(function(pair) {
                    console.log(pair[1], pair[0]);
                });
            });
        }

        if (program.unused) {
            var found = [];
            var used = [];
            results.forEach(function(result) {
                used = used.concat(result.files, _(result.packages).values().flatten().value());
                var target = config[result.target];
                found = found.concat(Object.keys(target.sources.$$symbolsMapCache.filesHash)
                    .filter(function(file) {
                        return path.extname(file) === '.js';
                    })
                    .map(function(file) {
                        return finalizePath(target, file);
                    }));
            });
            used = _.uniq(used);
            found = _.uniq(found);
            console.log('Unused js files:');
            console.log(JSON.stringify(_.difference(found, used).sort(), null, 4));
        }

        //copyto
        if (program.copyto) {
            var copyFiles = [];
            results.forEach(function(result) {
                copyFiles = copyFiles.concat(result.files);
                if (result.packages) {
                    _.forOwn(result.packages, function(files) {
                        copyFiles = copyFiles.concat(files);
                    });
                }
            });
            copyFiles.forEach(function(file) {
                file = file.substr(1);
                var dest = path.resolve(program.copyto, file);
                mkdirp(path.dirname(dest), function(err) {
                    if (!err) {
                        fs.createReadStream(path.resolve(sitePath, file)).pipe(fs.createWriteStream(dest));
                    }
                });
            });
        }

        //caching
        if (!program.nocache) {
            return cache.save();
        }
    })
    .then(function() {
        if (program.time) {
            console.log('executing time: ' + (new Date().getTime() - timeStart));
        }
    })
    .catch(processError)
    .done();