module.exports = {
    'current': {
        extend: 'main',

        include: [
            'target:header'
        ],

        packages: {
            first: {
                sources: [
                    {
                        symbol: ['md5', 'md5'],
                        file: 'resources/md5/md5.min.js',
                        analyze: false
                    }
                ],

                include: [
                    'md5'
                ]
            },
            
            second: {
                include: [
                    'Stm.ui.hl.help.Page'
                ]
            }
        }
    }
};