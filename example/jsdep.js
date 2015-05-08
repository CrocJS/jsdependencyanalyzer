module.exports = {
    'general': {
        //путь до папки с js
        root: 'D:/work/projects/active/d/js/',
        site: 'D:/work/projects/active/',
        siteAbsolute: true,

        options: {
            htmlSymbolRegexp: /data-xtype="(.*?)"/g,
            htmlSymbolsMap: {
                'FormsHelper::chooseSubway': 'Stm.form.field.ChooseSubway'
            }
        },

        //источники для поиска доступных файлов (символов)
        sources: [
            {
                path: 'components/',
                prefix: 'Stm.'
            },
            {
                path: 'core/',
                prefix: 'Stm.',
                getSymbol: function(ref) {
                    return ref === 'Stm' ? 'Stm' : ':default';
                }
            },
            {
                file: 'Stm.utils.js',
                symbol: 'Stm.utils',
                ignore: [
                    'Stm.utils.domSetClipboardLink',
                    'swfobject',
                    '$.zclip'
                ]
            },
            {
                symbol: 'Stm.utils.domSetClipboardLink',
                dependencies: {
                    'swfobject': 'use',
                    '$.zclip': 'use'
                }
            },
            {
                path: 'controllers/',
                prefix: 'Stm.controllers.'
            },
            {
                path: 'services/',
                prefix: 'Stm.services.'
            },
            {
                path: 'stores/',
                getSymbol: function(ref) {
                    var refEnd = ref.match(/[^//]*$/)[0];
                    if (refEnd.substr(0, 4) === 'Stm.') {
                        return refEnd;
                    }
                    return 'Stm.store.' + ref.replace(/\//g, '.');
                }
            },
            {
                symbol: ['$', 'jQuery'],
                file: [
                    'resources/jquery/lib/jquery-1.10.2.min.js',
                    'resources/jquery/lib/jquery-migrate-1.2.1.min.js',
                    'resources/jquery/lib/jquery.override.js'
                ],
                analyze: false
            },
            {
                symbol: ['$.oridomi', 'jQuery.oridomi'],
                file: 'resources/jquery/oridomi/jquery.oridomi.min.js',
                dependencies: {'$': 'require'},
                analyze: false
            },
            {
                symbol: 'swfobject',
                file: 'resources/swfobject/swfobject.min.js',
                analyze: false
            },
            {
                symbol: ['$.zclip', 'jQuery.zclip'],
                file: 'resources/jquery/zclip/jquery.zclip.fixed.min.js',
                dependencies: {'swfobject': 'use', '$': 'require'},
                analyze: false
            }
        ]
    },

    'header': {
        extend: 'general',

        include: [
            'modules/header/default.js',
            'modules/header/city.js'
        ]
    },

    'main': {
        extend: 'general',

        //файлы и символы для подключения
        include: [
            'resources/jquery/lib/jquery-1.10.2.min.js',
            'core/Compatibility.js',
            'core/Stm.js',
            'components/form/types/LocationSearch.js',
            'components/ui/hl/pages/postcard/Cover.js',
            'Stm.controllers.Initialize'
        ]
    },

    'map': {
        extend: 'general',

        include: [
            'Stm.ui.map.MultiMap'
        ]
    },

    'editAddressBook': {
        extend: 'general',

        include: [
            '/templates/account/page_addressbook_edit.php'
        ]
    },

    'pickpointsMap': {
        extend: 'general',

        include: [
            '/prototypes/gui/popups/pickpoints-map-js.html'
        ]
    }
};