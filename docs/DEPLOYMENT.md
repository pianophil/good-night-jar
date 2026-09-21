# Good Night Jar Together: Betrieb und Freischaltung

Stand: 21. September 2026. Implementierte Pilotversion, noch kein gestarteter Zahlungsbetrieb.

## Was bereits funktioniert

- Bestehende Apps in `/` und `/custom-name/` bleiben unverändert.
- Neue mobile PWA unter `/couple/`: lokaler Zähler, Namen, sechs Designs, Farben, Sound, Rückgängig, Statistik, JSON-Sicherung und Wiederherstellung. Bestehender Custom-Name-Stand wird auf derselben Origin beim ersten Start übernommen; bestehende Schlüssel werden nicht verändert.
- Together-Backend: Anmeldung über einmaligen E-Mail-Link, sichere Sitzung, Stripe Checkout und Kundenportal, Freischaltung anhand des serverseitig abgefragten Abostatus, Einladung einer zweiten Person, gemeinsame Einträge, Export, Trennung und Kontolöschung.
- Die lokale App arbeitet ohne Backend. GitHub Pages führt jedoch keinen Node-Server aus. Dort sind Konto und Kauf korrekt deaktiviert. Kein Platzhalter-Kauf erzeugt eine Freischaltung.

## Schnellstart

Node 24 oder neuer. Keine npm-Pakete erforderlich.

```sh
cp .env.example .env
npm test
npm start
```

Lokal: `http://localhost:3000/couple/`. Ohne Zugangsdaten ist nur das lokale Produkt aktiv.

## Live-Inbetriebnahme

1. Einen Node-24-Host mit **dauerhaftem Datenträger** und HTTPS-Domain einrichten. Ein einzelner Prozess betreibt SQLite. Nicht auf einem flüchtigen Serverless-Dateisystem starten. Keine parallelen Replikate mit getrennten Datenbanken betreiben.
2. `.env` aus `.env.example` konfigurieren. `APP_ORIGIN` muss genau die öffentliche HTTPS-Origin sein. `DATABASE_PATH` auf dauerhaftes Volume legen. Die Beispieldatei enthält keine echten Zugangsdaten.
3. Resend-Konto mit verifizierter Absenderdomain und `MAIL_FROM` einrichten. Authentifizierung sendet einen einmaligen, 15 Minuten gültigen Link. Resend-API-Key nur serverseitig hinterlegen.
4. Stripe-Konto des Betreibers verifizieren und Auszahlungskonto verbinden. Zuerst Testmodus verwenden.
5. Stripe-Produkt „Good Night Jar Together“ mit zwei wiederkehrenden EUR-Preisen einrichten: 299 Cent/Monat und 2499 Cent/Jahr, Intervallanzahl 1, **tax_behavior=inclusive**. Preis-IDs in `.env` setzen. Server kontrolliert Betrag, Währung, Intervall und Steuerdarstellung vor jedem Checkout.
6. Stripe-Checkout-Einstellungen: Geschäftsname, Kontakt, Nutzungsbedingungen, Datenschutz und Branding ausfüllen. Kundenportal aktivieren: Rechnungen, Zahlmethoden und Kündigung zum Laufzeitende. Ein Tarifwechsel über das Portal ist in dieser Version nicht vorgesehen; keine fremden Produkte zur Auswahl anbieten.
7. Webhook auf `https://DEINE-DOMAIN/api/webhook`: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Signing Secret einsetzen. Verwendete Stripe-API-Version: `2025-06-30.basil`.
8. `TERMS_URL`, `PRIVACY_URL`, `IMPRINT_URL` auf veröffentlichte Betreibertexte setzen. Verfügbarkeit dieser URLs ersetzt keine rechtliche Prüfung. Widerruf, Leistungsbeginn, automatische Verlängerung, Verbraucher-Kündigungsweg und steuerliche Registrierung müssen für das Betreiberland konkret geklärt werden. Keine erfundene Adresse einsetzen.
9. Stripe Tax nur nach korrekter Registrierung aktivieren (`STRIPE_AUTOMATIC_TAX=true`). Der Schalter meldet keine steuerlichen Registrierungen an. Bei `false` muss die Umsatzsteuer außerhalb dieser Automatik korrekt abgewickelt werden.
10. Mit zwei realen Testkonten auf zwei Handys die nachstehende Abnahme durchführen. Erst dann Live-Schlüssel und Live-Preis-IDs setzen. Keine geheimen Schlüssel in GitHub oder den Chat kopieren; direkt im Hosting-Dashboard eintragen.

## Abnahme vor echten Verkäufen

- Resend-Zustellung, Spamordner, abgelaufener und erneut benutzter Link.
- Stripe-Testkarte: Erfolg, Abbruch, abgelehnte Karte, gegebenenfalls 3-D Secure. Webhook-Verzögerung und Wiederholung. Erfolgs-URL allein schaltet nichts frei.
- Einladung auf zweitem Handy öffnen, mit eigener E-Mail anmelden, ausdrücklich verbinden. Stand innerhalb von ca. 10 Sekunden bei geöffneter App sichtbar. Kein Push im Hintergrund.
- Beide schreiben gleichzeitig: Konflikt wird gemeldet, Anzeige neu geladen, kein stilles Überschreiben. Bei Netzwerkfehler muss erneut versucht werden; Cloud-Einträge werden nicht offline gepuffert.
- Abo kündigen: bis bezahltem Ende nutzbar; danach Lesen, Export und Trennen weiterhin möglich. Ausbleibender Webhook verlängert Zugriff nicht unbegrenzt.
- Kontolöschung: eigene Abos zuerst beenden; Besitzer löscht gemeinsames Glas, eingeladene Person entfernt ihren Zugang. Rechnungspflichten beim Zahlungsanbieter bleiben separat bestehen.
- Wiederherstellung aus Datenbank-Backup, Fehleralarm und Monitoring tatsächlich testen.
- Betreibertexte, verbrauchergerechte Kündigung einschließlich Anforderungen außerhalb eines Logins und Steuerkonfiguration abnehmen lassen. Diese Pilotversion liefert das Kundenportal, keine abschließende rechtliche Umsetzung aller Verkaufsländer.

## Sicherheits- und Betriebsgrenzen

HttpOnly/SameSite-Cookies, Secure unter HTTPS, Origin-Prüfung für schreibende API-Aufrufe, serverseitige Mitgliedschaftsprüfung, 256-Bit-Einladungen mit Ablauf/Einmalnutzung, gehashte Sitzungs- und Link-Token, versionierte Schreibvorgänge und rohe HMAC-Webhooks sind implementiert. Dies ist kein unabhängiges Security-Audit.

Lokale Browserdaten sind nicht Ende-zu-Ende verschlüsselt. Cloud-Daten liegen in der Datenbank; Hosting-Verschlüsselung, Backups und Auftragsverarbeitungsverträge sind Betriebsaufgaben. Freier Browsermodus sendet keine Analysedaten. Anmeldung und gemeinsame Nutzung verursachen API-Zugriffe. Netzwerkprotokolle und Mail-/Zahlungsanbieter müssen in der Datenschutzerklärung berücksichtigt werden.

Rate Limits arbeiten anhand der direkten Netzwerkadresse. Hinter einem Proxy teilen sich gegebenenfalls mehrere Kunden dieses Limit; am Reverse Proxy zusätzlich pro echter Client-IP begrenzen und die App nicht direkt öffentlich freigeben. `X-Forwarded-For` wird bewusst nicht ungeprüft vertraut. Vor breitem Launch verteilte Rate Limits und ein Lasttest einplanen.

Kein automatisches Refund-Handling: Rückzahlung und Abo-Beendigung im Stripe-Dashboard gemeinsam bearbeiten. Eine Rückzahlung allein beendet ein Stripe-Abo nicht automatisch. Keine doppelte Erstattung auslösen.

SQLite ist für einen kontrollierten Pilotstart ausgelegt. Vor größerem Wachstum Last, Datenvolumen, Sperrzeiten und Backup-Wiederherstellung messen; gegebenenfalls auf verwaltetes Postgres und Streaming/Deltas migrieren. Der aktuelle Poll lädt den aktiven Verlauf, maximal 10.000 Einträge. Keine Aussage „für Millionen Nutzer lastgetestet“.

## Backups und Löschung

Regelmäßige konsistente SQLite-Backups über SQLite Backup API oder `VACUUM INTO` erstellen, verschlüsselt getrennt speichern und Wiederherstellung prüfen. Nicht nur die laufende Hauptdatei kopieren und WAL ignorieren. Tägliche Backups, sieben tägliche plus vier wöchentliche Stände sind ein möglicher Start; verbindliche Aufbewahrung und Wiederherstellung gelöschter Datensätze dokumentieren. Gelöschte/geleerte Einträge sind intern als voided markiert; endgültige Bereinigung und Logaufbewahrung vor Live-Betrieb festlegen.

## Verifikation dieses Entwicklungsstands

`npm test`: Signaturprüfung und Replay-Schutz; vollständiger Zwei-Personen-Lebenszyklus mit simuliertem Mail- und Stripe-Dienst; unerlaubter Fremdzugriff; doppelte Checkout-Anfrage; manipulierter Tarif; einmalige/abgelaufene Einladungen; Versionskonflikte; Ablauf; Export; Trennung und Kontolöschung. Anbieter wurden simuliert: keine Live-Abbuchung oder echte Mailzustellung getestet.
