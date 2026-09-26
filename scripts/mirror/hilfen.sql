-- Hilfsobjekte für den Prod-Mirror-Abzug. Werden in der STAGING-DB angelegt
-- und vor dem Umbenennen in prod_mirror wieder entfernt.

-- JSON pseudonymisieren: Struktur (Schlüssel, Verschachtelung, Zahlen, Wahrheitswerte)
-- bleibt. Zeichenketten werden durch "[x]" ersetzt, AUSSER
--   · unter fachlichen Schlüsseln (Status, Topf, Rechnungsnummer …) und
--   · wenn sie nur eine Zahl oder ein Datum/Zeitstempel sind.
-- Bewusst NICHT in der Liste: freie Felder wie "reason", "notes", "name".
CREATE OR REPLACE FUNCTION mirror_scrub(j jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  schluessel_bleiben CONSTANT text[] := ARRAY[
    'action','status','oldStatus','newStatus','budgetType','billingType','transactionType',
    'source','invoiceNumber','originalInvoiceNumber','stornoInvoiceNumber','invoiceType',
    'entityType','targetPot','pot','potKey','trigger','mode','type','kind','noteKind','role',
    'task','format','deliveryMethod','eventType','field','fields','changedFields','budgetTypes',
    'splitPots','appointmentType','serviceCode','code','unit','quantityUnit','period','state'
  ];
  k text; v jsonb; res jsonb;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      res := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
        IF k = ANY (schluessel_bleiben) AND jsonb_typeof(v) = 'string' THEN
          res := res || jsonb_build_object(k, v);
        ELSIF k = ANY (schluessel_bleiben) AND jsonb_typeof(v) = 'array'
              AND NOT jsonb_path_exists(v, '$[*] ? (@.type() == "object" || @.type() == "array")') THEN
          res := res || jsonb_build_object(k, v);
        ELSE
          res := res || jsonb_build_object(k, mirror_scrub(v));
        END IF;
      END LOOP;
      RETURN res;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(mirror_scrub(e) ORDER BY n), '[]'::jsonb) INTO res
        FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, n);
      RETURN res;
    WHEN 'string' THEN
      IF (j #>> '{}') ~ '^(-?[0-9]+([.,][0-9]+)?|[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?)$' THEN
        RETURN j;
      END IF;
      RETURN to_jsonb('[x]'::text);
    ELSE
      RETURN j;
  END CASE;
END $$;

-- Zeilenzahl je Tabelle (Abnahme 1). Gleiche Abfrage für Prod (im Snapshot) und Mirror.
CREATE OR REPLACE FUNCTION mirror_zeilen() RETURNS TABLE (tabelle text, zeilen bigint)
LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname NOT LIKE 'mirror\_%' ORDER BY 1 LOOP
    tabelle := t;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO zeilen;
    RETURN NEXT;
  END LOOP;
END $$;

-- Suche nach Klarnamen, E-Mail- und IBAN-Mustern in ALLEN Text-/JSON-Spalten (Abnahme 3).
-- Liefert je Treffer-Spalte nur Tabelle, Spalte, Art und Anzahl — nie Werte.
CREATE OR REPLACE FUNCTION mirror_suche() RETURNS TABLE (tabelle text, spalte text, art text, anzahl bigint)
LANGUAGE plpgsql AS $$
DECLARE r record; namen_re text; n bigint; ausdruck text;
BEGIN
  SELECT '\m(' || string_agg(DISTINCT token, '|') || ')\M' INTO namen_re FROM mirror_pruef_namen;
  FOR r IN SELECT c.table_name AS t, c.column_name AS s, c.data_type AS typ
           FROM information_schema.columns c
           JOIN pg_class k ON k.relname = c.table_name
           JOIN pg_namespace ns ON ns.oid = k.relnamespace AND ns.nspname = 'public'
           WHERE c.table_schema = 'public' AND k.relkind IN ('r','p')
             AND c.table_name NOT LIKE 'mirror\_%'
             AND (c.data_type IN ('text','character varying','character','json','jsonb')
                  OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text','_varchar','_bpchar')))
  LOOP
    ausdruck := format('%I::text', r.s);
    IF namen_re IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %s ~* $1', r.t, ausdruck) INTO n USING namen_re;
      IF n > 0 THEN tabelle := r.t; spalte := r.s; art := 'name'; anzahl := n; RETURN NEXT; END IF;
    END IF;
    EXECUTE format($q$SELECT count(*) FROM public.%I
                     WHERE regexp_replace(%s, '[A-Za-z0-9._%%+-]+@mirror\.invalid', '', 'g')
                           ~ '[A-Za-z0-9._%%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'$q$, r.t, ausdruck) INTO n;
    IF n > 0 THEN tabelle := r.t; spalte := r.s; art := 'email'; anzahl := n; RETURN NEXT; END IF;
    EXECUTE format($q$SELECT count(*) FROM public.%I
                     WHERE %s ~ '\m[A-Z]{2}[0-9]{2} ?([0-9A-Z]{4} ?){3,7}[0-9A-Z]{1,4}\M'$q$, r.t, ausdruck) INTO n;
    IF n > 0 THEN tabelle := r.t; spalte := r.s; art := 'iban'; anzahl := n; RETURN NEXT; END IF;
  END LOOP;
END $$;
