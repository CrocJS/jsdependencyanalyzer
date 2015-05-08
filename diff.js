"use strict";

var path = require('path');
var fs = require('fs');

var program = require('commander');
var _ = require('lodash');

program.parse(process.argv);

var res1 = JSON.parse(fs.readFileSync(program.args[0], {encoding: 'utf8'}));
var res2 = _.indexBy(JSON.parse(fs.readFileSync(program.args[1], {encoding: 'utf8'})), 'target');
var diffs = [];

res1.forEach(function(target1, index) {
    var target2 = res2[target1.target];
    if (!target2) {
        return;
    }

    var targetDiff = {
        target: target1.target,
        files: [
            _.difference(target1.files, target2.files),
            _.difference(target2.files, target1.files)
        ],
        packages: {}
    };

    if (!targetDiff.files[0].length && !targetDiff.files[1].length) {
        delete targetDiff.files;
    }

    _.union(Object.keys(target1.packages || {}), Object.keys(target2.packages || {}))
        .forEach(function(pack) {
            var package1 = target1.packages && target1.packages[pack];
            var package2 = target2.packages && target2.packages[pack];
            if (!package1 || !package2) {
                targetDiff.packages[pack] = !package1 ? 2 : 1;
            }
            else {
                var diff1 = _.difference(package1, package2);
                var diff2 = _.difference(package2, package1);
                if (diff1.length || diff2.length) {
                    targetDiff.packages[pack] = [diff1, diff2];
                }
            }
        });

    if (targetDiff.files || !_.isEmpty(targetDiff.packages)) {
        diffs.push(targetDiff);
    }
});

console.log('\n\n');
if (!diffs.length) {
    console.log('Результаты совпадают');
}
else {
    var printDiff = function(diff) {
        if (typeof diff === 'number') {
            console.log(diff === 1 ? 'Удалён' : 'Добавлен');
        }
        else {
            if (diff[0].length) {
                console.log('Удалено:');
                console.log(diff[0]);
            }
            if (diff[1].length) {
                if (diff[0].length) {
                    console.log('\n');
                }
                console.log('Добавлено:');
                console.log(diff[1]);
            }
        }
    };

    diffs.forEach(function(diff) {
        console.log('-----\nTarget ' + diff.target + '\n\n');
        if (diff.files) {
            console.log('> core' + '\n');
            printDiff(diff.files);
            console.log('\n');
        }
        _.forOwn(diff.packages, function(packDif, pack) {
            console.log('> ' + pack + '\n');
            printDiff(packDif);
            console.log('\n');
        });
    });
}