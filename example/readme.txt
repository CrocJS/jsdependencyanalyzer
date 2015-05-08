#установка (в папке сборщика)
npm install

#в конфиге поменять пути root и site на свои

#собрать главный пакет (вывести в консоль)
node build.js -p ./example -t main

#собрать модули шапки сайта
node build.js -p ./example -t header

#собрать цель с дочерними пакетами
node build.js -p ./example/subfolder

#собрать зависимости из шаблона /templates/account/page_addressbook_edit.php
node build.js -p ./example -t editAddressBook

#собрать зависимости для страницы прототипа /prototypes/gui/popups/pickpoints-map-js.html
node build.js -p ./example -t pickpointsMap