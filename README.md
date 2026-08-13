# pr-review

Claude-Code-Plugins als Marketplace. Öffentlich, weil der Inhalt generisch ist —
projektspezifische Konfiguration lebt in den jeweiligen Projekt-Repos.

## Installation

```bash
claude plugin marketplace add comprevace/pr-review
```

```bash
claude plugin install pr-review@pr-review
```

## Plugin `pr-review`

Agentisches PR-Review. `/pr-review:review 55` baut aus dem PR ein eingefrorenes
Kontext-Bundle, setzt spezialisierte Reviewer-Subagenten darauf an, aggregiert deren
Befunde und platziert sie in einem einzigen API-Call als Inline-Kommentare.

Adressat der Kommentare ist ein Coding-Agent: jeder Befund trägt ein wörtliches
Zitat als Evidenz und einen Handlungsauftrag im Imperativ.

Das Review ist ein **Signal, kein Gate**. Es gibt kein Approve und keinen
Merge-Einfluss.

### Wie es arbeitet

1. `fetch` holt den PR über `gh` und friert ihn als Bundle ein: Diff, betroffene
   Dateien im Stand des PR-Branches, zugehörige Tests, die verlinkte Spec.
2. Die Skill wählt die Analysten aus und startet sie parallel. Jeder sieht nur das
   Bundle — kein Netz, kein `gh`, kein Repo-Zugriff.
3. `post` validiert jeden Befund gegen das Bundle, wirft Erfundenes weg, fasst
   Überlappungen zu einem Kommentar mit mehreren Tags zusammen und prüft jeden
   Zeilenanker, bevor irgendetwas gesendet wird.
4. `verify` läuft auf demselben PR erneut: erledigte Threads werden aufgelöst, offene
   bleiben, wieder aufgetauchte werden erneut gemeldet.

Ein Befund gilt nur dann als behoben, wenn **beide** Bedingungen gelten: kein Analyst
meldet ihn erneut, und das zitierte Fragment steht nicht mehr in der Datei. Jede
Bedingung allein wäre austrickbar — durch eine umformulierte Zeile oder durch einen
Analysten, der abgestürzt ist.

### Analysten erweitern

Ein Analyst ist eine Datei, kein Code. Lege sie unter `analysts/` im Plugin ab oder
unter `.claude/pr-review-analysts/` in deinem Projekt-Repo — letztere gewinnt bei
gleichem Namen. Aufbau und Regeln stehen in
[`analyst-contract.md`](plugins/pr-review/analyst-contract.md).

Mitgeliefert sind zwei Referenz-Analysten: `gate-integrity` (wurde die Prüfschicht
selbst angetastet?) und `spec-fidelity` (tut der Diff, was er sollte — und nur das?).

### Tests

```bash
cd plugins/pr-review && node --test 'test/*.test.mjs'
```

116 Tests, keine Dependencies, Node ≥ 22.

## Lizenz

MIT
