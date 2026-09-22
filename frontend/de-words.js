/* Common German (+ a bit of English) for local spelling hints. */
(function (root) {
  "use strict";
  const SOFIA_DE_WORDS = `
der die das den dem des ein eine einer eines einem einen und oder aber
weil dass dann wenn als wie wo wer was warum nicht nur auch noch schon
sehr mehr weniger hier dort jetzt heute gestern morgen immer nie oft
ich du er sie es wir ihr mir mich dir dich uns euch ihm ihn ihnen
mein meine mein mein mein dein seine ihre unser euer
haben hat hatte haben sein ist war waren werden wird wurde
können kann müssen muss sollen soll wollen will dürfen darf
machen tun gehen kommen sehen geben nehmen finden sagen denken wissen
lernen schreiben rechnen lesen malen zeichnen üben wiederholen
schule klasse stunde fach lehrer lehrerin schüler schülerin
hausaufgabe hausaufgaben aufgabe aufgaben hefte heft buch bücher
tafel whiteboard notiz notizen seite seiten kapitel thema
mathematik mathe rechnen zahl zahlen ziffer plus minus mal geteilt
gleich wurzel bruch brüche prozent pi quadrat rechteck dreieck
kreis winkel seite höhe länge breite umfang fläche volumen
deutsch sprache wort wörter satz sätze text texte rechtschreibung
grammatik großschreibung komma punkt frage
englisch history geschichte erdkunde biologie chemie physik
musik kunst sport religion werken informatik
pflanze tier körper wasser luft erde sonne mond stern
zelle atom energie kraft geschwindigkeit zeit
photosynthese chlorophyll osmose evolution
deutschland europa berlin hamburg münchen
montag dienstag mittwoch donnerstag freitag samstag sonntag
januar februar märz april mai juni juli august september oktober november dezember
frühling sommer herbst winter
farbe rot blau grün gelb schwarz weiß grau orange lila braun
gut schlecht richtig falsch schön wichtig einfach schwer schnell langsam
groß klein neu alt jung viel wenig kurz lang hoch tief
freund freundin familie mutter vater kind kinder
haus wohnung zimmer tisch stuhl tür fenster
essen trinken brot wasser milch apfel
bitte danke hallo tschüss guten morgen abend
übung übungen lösung lösungen ergebnis ergebnisse
beispiel beispiele regel regeln merksatz
gleichung gleichungen formel formeln funktion
addition subtraction subtraction subtraktion multiplikation division
quadratwurzel potenz exponent bruchrechnen
celsius grad meter kilometer zentimeter gramm kilogram milliliter liter
uhr minute stunde tag woche monat jahr
name titel überschrift unterricht pause pause pause
computer handy internet video bild foto
projekt gruppe partner arbeit arbeitsblatt
test klausel klausur probe arbeit note punkte
fehler fehlerfrei korrektur verbessern
links rechts oben unten mitte davor danach zwischen
erste zweite dritte nächste letzte
warum deshalb darum außerdem schließlich
können könnten würden sollten müssten
geschrieben gerechnet gelesen gelernt gemacht gekommen
aufgabe rechnen textaufgabe sachaufgabe
dreisatz prozentrechnung flächeninhalt umfang
pythagoras thales sinus kosinus tangens
variable unbekannte lösen einsetzen
kommazahl nachkommastelle runden schätzen
gerade ungerade primzahl teiler vielfaches
bruchstrich zähler nenner kürzen erweitern
gemischte zahl dezimalzahl
ich du wir ihr sie man jemand niemand etwas
über unter vor nach aus bei mit ohne für gegen um an auf in
nochmal nochmals bitte sofort danach zuerst zuletzt
hausaufgabe erledigen abgeben sammeln
hefteintrag überschrift datum
strich punkt linie pfeil kasten
wurzelzeichen gleichheitszeichen pluszeichen
malzeichen geteiltzeichen klammern
pi quadratwurzel prozent
hallo welt danke bitte ja nein
the and for with from this that what when where
homework school class teacher student
note notes page chapter
`.replace(/\s+/g, " ").trim();

  root.SOFIA_DE_WORDS = SOFIA_DE_WORDS;
  if (typeof module !== "undefined" && module.exports) module.exports = SOFIA_DE_WORDS;
})(typeof globalThis !== "undefined" ? globalThis : this);
