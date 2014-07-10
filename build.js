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

var commaSeparated = function(x) { return _.compact(x.split(',')); };

program
    .option('-p, --path [path]', 'Path to jsdep.js', path.resolve, __dirname)
    .option('-t, --target [target]', 'Target(s) to build (separated by comma)', commaSeparated, ['current'])
    .option('-c, --compare [compare]', 'Compare with manual')
    .option('-a, --add [add]', 'Add file or symbol')
    .option('-o, --only [only]', 'Build only one package in target')
    .option('-s, --statistics [statistics]', 'Statistics of file usage in packages')
    .option('-d, --dependencies [dependencies]', 'Print dependencies between files')
    .option('-e, --debug [debug]', 'Debug mode (print stack for errors)')
    .option('-j, --jsincludes [jsincludes]', 'Print generated js_includes for packages')
    .option('--time', 'Print executing time')
    .option('--nocache', 'Build without cache')
    .option('--nodirchange', 'Sources directories havn\'t changed')
    .option('--changed [changed]', 'Sources files which have benn changed. Specify "no" if there is no changed files.',
        commaSeparated)
    .option('--added [added]', 'Sources files which have benn added. Specify "no" if there is no added files.',
        commaSeparated)
    .option('--removed [removed]', 'Sources files which have benn removed. Specify "no" if there is no removed files.',
        commaSeparated)
    .parse(process.argv);

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

var jsIncludesUrl = 'http://active.www.dev.sotmarket.ru/prototypes/resources/js_includes_output.php';
if (program.compare && typeof program.compare !== 'string') {
    program.compare = jsIncludesUrl;
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

//var config = {};
//var lastPath;
//var curPath = program.path;
//var first = true;
//do {
//    var curConfigPath = path.join(curPath, 'jsdep.js');
//    if (!fs.existsSync(curConfigPath)) {
//        if (first) {
//            throw new Error('No such file: ' + curConfigPath);
//        }
//    }
//    else {
//        var curConfig = require(curConfigPath);
//        _.forOwn(curConfig, function(target, targetName) {
//            //noinspection JSReferencingMutableVariableFromClosure
//            if (first || targetName !== 'current') {
//                if (target.root) {
//                    //noinspection JSReferencingMutableVariableFromClosure
//                    target.root = path.resolve(curPath, target.root);
//                }
//                if (target.site) {
//                    //noinspection JSReferencingMutableVariableFromClosure
//                    target.site = path.resolve(curPath, target.site);
//                }
//
//                config[targetName] = target;
//            }
//        });
//    }
//
//    lastPath = curPath;
//    curPath = path.join(lastPath, '../');
//    first = false;
//} while (curPath !== lastPath);

var config;
try {
    config = require(confPath);
}
catch (ex) {
    throw new Error('Corrupted config file: ' + confPath);
}

/**
 * @param target
 * @param [isPackage=false]
 * @returns {*}
 */
function resolveTarget(target, isPackage) {
    if (target.ready || !target.extend) {
        return target;
    }

    var parentTarget = typeof target.extend === 'string' ? resolveTarget(config[target.extend]) : target.extend;
    if ('root' in parentTarget && !('root' in target)) {
        target.root = parentTarget.root;
    }
    else if (target.root) {
        target.root = path.resolve(program.path, target.root);
    }

    if ('site' in parentTarget && !('site' in target)) {
        target.site = parentTarget.site;
    }
    else if ('site' in target) {
        target.site = path.resolve(program.path, target.site);
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
            targetsDeferreds.push(buildTarget(target, null,
                program.add ? [program.add] : null).then(function(result) {
                    result.target = targetName;
                    if (result.files) {
                        result.files = result.files.map(finalizePath.bind(global, target));
                    }
                    if (result.packages) {
                        result.packages = _.mapValues(result.packages, function(files) {
                            return files.map(finalizePath.bind(global, target))
                        });
                    }

                    return result;
                }));
        });

        return Q.all(targetsDeferreds);
    })
    .then(function(results) {
        if (!program.time) {
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

        if (program.compare) {
            http.get(program.compare, function(response) {
                var data = '';
                response.on('data', function(chunk) {
                    data += chunk;
                });
                response.on('end', function() {
                    var jsIncludes = JSON.parse(data);

                    results.forEach(function(result) {
                        console.log('\n');

                        if (results.length > 1) {
                            console.log('target: ' + result.target + '\n');
                        }

                        var original = jsIncludes[result.target];
                        console.log('Сравнение: core.php');
                        var manual = _.uniq(original.files);
                        console.log('Лишние файлы в js_includes');
                        console.log(_.difference(manual, result.files, null, 4));
                        console.log('Лишние файлы у сборщика');
                        console.log(_.difference(result.files, manual, null, 4));

                        if (result.packages) {
                            Object.keys(result.packages).sort().forEach(function(pack) {
                                var files = result.packages[pack];

                                console.log('\nСравнение: ' + pack);
                                var manual = _.uniq(original.packages[pack]);
                                console.log('Лишние файлы в js_includes');
                                console.log(_.difference(manual, files.concat(result.files), null, 4));
                                console.log('Лишние файлы у сборщика');
                                console.log(_.difference(files, manual.concat(original.files), null, 4));
                            });
                        }
                    });
                });
            });
        }

        if (program.jsincludes) {
            http.get(jsIncludesUrl, function(response) {
                var data = '';
                response.on('data', function(chunk) {
                    data += chunk;
                });
                response.on('end', function() {
                    var jsIncludes = JSON.parse(data);

                    results.forEach(function(result) {
                        console.log('\n');

                        if (results.length > 1) {
                            console.log('target: ' + result.target + '\n');
                        }

                        var original = jsIncludes[result.target];

                        if (program.jsincludes === 'core') {
                            result.files.forEach(function(file) {
                                console.log("array(\n    'type' => 'file',\n    'src'  => '" + file.substr(6) + "'\n),");
                            });
                        }
                        else if (result.packages) {
                            Object.keys(result.packages).sort().forEach(function(pack) {
                                var files = result.packages[pack];

                                var generatedPackage = _.uniq(_.difference(
                                    result.files.concat(files),
                                    original.files.concat('/d/js/resources/jquery/autogrowinput/jquery.autogrowinput.min.js')
                                ));
                                generatedPackage.forEach(function(packFile) {
                                    console.log("array(\n    'type' => 'file',\n    'src'  => '" + packFile.substr(6) + "'\n),");
                                });
                            });
                        }
                    });
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