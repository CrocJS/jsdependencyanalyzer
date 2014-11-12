"use strict";

var path = require('path');
var fs = require('fs');

var program = require('commander');
var _ = require('lodash');
var Q = require('q');
var mkdirp = require('mkdirp');

var library = require('./library');
var cache = require('./cache');
var TargetBuilder = require('./TargetBuilder');

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
    'Sources files which have been removed. Specify --removed= if there is no removed files.',
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

var targetBuilder = new TargetBuilder(config);

//resolve "run" targets
program.target = targetBuilder.flattenTargets(program.target);

//process program.added/removed
var sitePath = path.resolve(program.path, targetBuilder.resolveTarget(config[program.target[0]]).site);
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
        return Q.all(program.target.map(function(name) {
            return targetBuilder.build(name);
        }));
    })
    .then(function(results) {
        //выводим результат
        if (!program.time && !program.unused) {
            console.log(JSON.stringify(results.length > 1 ? results : results[0], null, 4));
        }

        //статистика по подключённым файлам в разных пакетах
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
                    if (parseInt(pair[1]) > 1) {
                        console.log(pair[1], pair[0]);
                    }
                });
            });
        }

        //неиспользованные файлы
        if (program.unused) {
            var found = [];
            var used = [];
            results.forEach(function(result) {
                used = used.concat(result.files, _(result.packages).values().flatten().value());
                var target = config[result.target];
                found = found.concat(Object.keys(target.sources.$$symbolsMapCache.filesHash)
                    .map(function(file) {
                        return library.finalizePath(target, file);
                    }));
            });
            used = _.uniq(used);
            found = _.uniq(found);
            var unused = _.difference(found, used).sort();
            console.log('Unused js files:');
            console.log(JSON.stringify(unused.filter(function(x){ return path.extname(x) === '.js'; }), null, 4));
            console.log('\nUnused css files:');
            console.log(JSON.stringify(unused.filter(function(x){ return path.extname(x) === '.css'; }), null, 4));
        }

        //копирование собранных файлов в произвольную папку
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

        //кеширование данных
        if (!program.nocache) {
            return cache.save();
        }
    })
    .then(function() {
        //замер времени выполнения
        if (program.time) {
            console.log('executing time: ' + (new Date().getTime() - timeStart));
        }
    })
    .catch(processError)
    .done();