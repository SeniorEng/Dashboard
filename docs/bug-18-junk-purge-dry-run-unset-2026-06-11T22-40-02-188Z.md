# BUG-18 — Junk-Stammdaten-Purge — Dry-Run-Report

> **AUTOMATISCH ERZEUGT — read-only Dry-Run, KEINE Mutation.**
> Erzeugt mit `npm run purge:junk-master-data` (ohne `--apply`).
> Der destruktive Lauf erfolgt erst nach expliziter Freigabe (Alrik) mit
> `--apply` UND gesetztem `JUNK_PURGE_PROD_APPROVED`.

- **Erzeugt am:** 2026-06-11T22:40:02.188Z
- **NODE_ENV:** `(unset)`
- **DB-Host:** `helium`

## Zusammenfassung

| Tabelle | Hart löschen | Deaktivieren | Echte (geschützte) Stammdaten |
|---|---:|---:|---:|
| `services` | 0 | 217 | 5 |
| `document_types` | 0 | 0 | 22 |

Erhaltungs-Anker (dürfen sich durch den Purge NICHT ändern):
- Echte Service-IDs: `[15, 16, 17, 18, 19]`
- Echte Dokumenttyp-IDs: `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]`

## services — hart zu löschen (referenzlos)

_(keine)_

## services — zu deaktivieren (referenziert)

| ID | Name | Code |
|---:|---|---|
| 2246 | QS-Pricing-Guard_test_1778186542273_ascfr |  |
| 3962 | QS-Pricing-Patch_test_1779964903207_610h5 |  |
| 3493 | QS-Pricing-Patch_test_1779460766304_ei5sx |  |
| 2811 | QS-Pricing-Guard_test_1778774135058_grrpj |  |
| 2874 | QS-Pricing-Guard_test_1778833850138_g5m6e |  |
| 3121 | QS-Pricing-Guard_test_1779190753849_s9qtx |  |
| 2875 | QS-Pricing-Patch_test_1778833851445_2g8uj |  |
| 3242 | QS-Pricing-Guard_test_1779221656416_3x2qp |  |
| 3135 | QS-Pricing-Guard_test_1779191381494_qq06v |  |
| 3243 | QS-Pricing-Patch_test_1779221657684_1pynn |  |
| 3961 | QS-Pricing-Guard_test_1779964901803_3d54g |  |
| 3694 | QS-Pricing-Guard_test_1779828987350_va5pc |  |
| 3508 | QS-Pricing-Guard_test_1779479076743_c3q10 |  |
| 3517 | QS-Pricing-Patch_test_1779481808054_vi56v |  |
| 3711 | QS-Pricing-Patch_test_1779832100802_vj5qr |  |
| 3655 | QS-Pricing-Patch_test_1779810658872_0jscb |  |
| 3758 | QS-Pricing-Guard_test_1779881589668_8aytw |  |
| 3759 | QS-Pricing-Patch_test_1779881590997_fxf0v |  |
| 2247 | QS-Pricing-Patch_test_1778186542879_gzqkd |  |
| 2812 | QS-Pricing-Patch_test_1778774136756_o0r8r |  |
| 2807 | QS-Pricing-Guard_test_1778772710611_ct7bv |  |
| 3122 | QS-Pricing-Patch_test_1779190755167_hvz0d |  |
| 2250 | QS-Pricing-Guard_test_1778186712278_d0431 |  |
| 2251 | QS-Pricing-Patch_test_1778186712907_uonbs |  |
| 2808 | QS-Pricing-Patch_test_1778772711886_3y4fj |  |
| 2010 | QS-Pricing-Guard_test_1778005353170_emiks |  |
| 2011 | QS-Pricing-Patch_test_1778005353708_uvjxf |  |
| 3136 | QS-Pricing-Patch_test_1779191382706_h441x |  |
| 2693 | QS-Pricing-Guard_test_1778704831259_wyn7e |  |
| 3492 | QS-Pricing-Guard_test_1779460764871_czy9f |  |
| 3509 | QS-Pricing-Patch_test_1779479077840_bty40 |  |
| 3695 | QS-Pricing-Patch_test_1779828988715_40h9b |  |
| 3646 | QS-Pricing-Guard_test_1779806685280_89hwr |  |
| 3647 | QS-Pricing-Patch_test_1779806686649_mu1fq |  |
| 3654 | QS-Pricing-Guard_test_1779810657708_d29nd |  |
| 3662 | QS-Pricing-Guard_test_1779817060422_9neun |  |
| 3663 | QS-Pricing-Patch_test_1779817061830_ayzfj |  |
| 3670 | QS-Pricing-Guard_test_1779818762803_5tj8o |  |
| 3671 | QS-Pricing-Patch_test_1779818764291_ac3hz |  |
| 3678 | QS-Pricing-Guard_test_1779822458243_89ez1 |  |
| 3679 | QS-Pricing-Patch_test_1779822459577_8wdzv |  |
| 3686 | QS-Pricing-Guard_test_1779826415919_07ycf |  |
| 3687 | QS-Pricing-Patch_test_1779826417357_p8pxy |  |
| 3808 | QS-Pricing-Patch_test_1779888882641_5l457 |  |
| 3817 | QS-Pricing-Guard_test_1779890506973_8udts |  |
| 3819 | QS-Pricing-Patch_test_1779890508770_6aiqx |  |
| 3863 | QS-Pricing-Guard_test_1779908678462_502pw |  |
| 3864 | QS-Pricing-Patch_test_1779908680134_dwgtk |  |
| 3871 | QS-Pricing-Guard_test_1779912484312_7jkio |  |
| 3880 | QS-Pricing-Patch_test_1779913184630_f63jv |  |
| 3886 | QS-Pricing-Patch_test_1779913883049_rxbxo |  |
| 3895 | QS-Pricing-Guard_test_1779950429302_g2x5g |  |
| 3896 | QS-Pricing-Patch_test_1779950430512_7gslm |  |
| 3927 | QS-Pricing-Guard_test_1779959273329_zuftx |  |
| 3928 | QS-Pricing-Patch_test_1779959274659_sap9m |  |
| 3936 | QS-Pricing-Patch_test_1779960762168_xc7lm |  |
| 2694 | QS-Pricing-Patch_test_1778704832438_yt76g |  |
| 2854 | QS-Pricing-Guard_test_1778831504269_g3n76 |  |
| 3150 | QS-Pricing-Patch_test_1779203627734_g4p9n |  |
| 3149 | QS-Pricing-Guard_test_1779203626405_7lozh |  |
| 3156 | QS-Pricing-Guard_test_1779206984882_y6hbd |  |
| 3107 | QS-Pricing-Guard_test_1779190135644_2dvc3 |  |
| 3108 | QS-Pricing-Patch_test_1779190136771_pk7i9 |  |
| 3110 | QS-Pricing-Patch_test_1779190140247_egbvn |  |
| 3221 | QS-Pricing-Guard_test_1779220075551_qphi3 |  |
| 3235 | QS-Pricing-Guard_test_1779220722281_wmfn3 |  |
| 2855 | QS-Pricing-Patch_test_1778831505371_xjuyz |  |
| 3157 | QS-Pricing-Patch_test_1779206986015_moypo |  |
| 3533 | QS-Pricing-Patch_test_1779483872951_e6eur |  |
| 3109 | QS-Pricing-Guard_test_1779190139094_wjuca |  |
| 3525 | QS-Pricing-Patch_test_1779482943205_s6gch |  |
| 3222 | QS-Pricing-Patch_test_1779220076696_4fasx |  |
| 3236 | QS-Pricing-Patch_test_1779220723521_2nsf4 |  |
| 3562 | QS-Pricing-Patch_test_1779688386059_065xr |  |
| 3524 | QS-Pricing-Guard_test_1779482941842_101ce |  |
| 3532 | QS-Pricing-Guard_test_1779483871632_c3cit |  |
| 3971 | QS-Pricing-Guard_test_1779965790614_zbl4f |  |
| 3346 | QS-Pricing-Guard_test_1779304025830_mxh0g |  |
| 3537 | QS-Pricing-Guard_test_1779484473622_3g1li |  |
| 3289 | QS-Pricing-Guard_test_1779251460543_vuqa3 |  |
| 3347 | QS-Pricing-Patch_test_1779304027249_9q8fj |  |
| 3553 | QS-Pricing-Guard_test_1779514245012_8dgp7 |  |
| 3303 | QS-Pricing-Guard_test_1779261659630_udkey |  |
| 3561 | QS-Pricing-Guard_test_1779688384933_udu7l |  |
| 3569 | QS-Pricing-Guard_test_1779796109194_tsv6s |  |
| 3585 | QS-Pricing-Guard_test_1779798720730_n7ynk |  |
| 3593 | QS-Pricing-Guard_test_1779800863098_5n31a |  |
| 3422 | QS-Pricing-Guard_test_1779389430527_mq84k |  |
| 3353 | QS-Pricing-Guard_test_1779311037574_czc52 |  |
| 3427 | QS-Pricing-Guard_test_1779389820850_r6vow |  |
| 3750 | QS-Pricing-Guard_test_1779874189460_pym3o |  |
| 3373 | QS-Pricing-Guard_test_1779374840784_a3spx |  |
| 3380 | QS-Pricing-Guard_test_1779384562697_66qhs |  |
| 3387 | QS-Pricing-Guard_test_1779386398625_sqalu |  |
| 3435 | QS-Pricing-Guard_test_1779391558355_p6mpi |  |
| 3476 | QS-Pricing-Guard_test_1779460109265_x6mk7 |  |
| 2105 | QS-Pricing-Guard_test_1778077612255_umypt |  |
| 3290 | QS-Pricing-Patch_test_1779251461855_yeh14 |  |
| 3855 | QS-Pricing-Guard_test_1779905309802_ssb4u |  |
| 3538 | QS-Pricing-Patch_test_1779484474934_m9zsf |  |
| 3304 | QS-Pricing-Patch_test_1779261660931_l705x |  |
| 3554 | QS-Pricing-Patch_test_1779514246245_z7i4v |  |
| 3726 | QS-Pricing-Guard_test_1779836956985_acf5l |  |
| 3570 | QS-Pricing-Patch_test_1779796110247_qt4ww |  |
| 3718 | QS-Pricing-Guard_test_1779832764504_d6qvd |  |
| 3586 | QS-Pricing-Patch_test_1779798721945_eekak |  |
| 3734 | QS-Pricing-Guard_test_1779838611129_1mxyo |  |
| 3354 | QS-Pricing-Patch_test_1779311038538_b2k4u |  |
| 3594 | QS-Pricing-Patch_test_1779800864232_hfo58 |  |
| 3626 | QS-Pricing-Guard_test_1779801888200_u3jq0 |  |
| 3735 | QS-Pricing-Patch_test_1779838612305_c9ler |  |
| 3627 | QS-Pricing-Patch_test_1779801889404_spurr |  |
| 3634 | QS-Pricing-Guard_test_1779803376343_dk5ja |  |
| 3742 | QS-Pricing-Guard_test_1779864017524_efzos |  |
| 3751 | QS-Pricing-Patch_test_1779874191286_69em1 |  |
| 3374 | QS-Pricing-Patch_test_1779374842569_kqszb |  |
| 3381 | QS-Pricing-Patch_test_1779384564237_s06j9 |  |
| 3388 | QS-Pricing-Patch_test_1779386400182_v9w1o |  |
| 3428 | QS-Pricing-Patch_test_1779389822095_cw2fm |  |
| 3423 | QS-Pricing-Patch_test_1779389431667_18krj |  |
| 3436 | QS-Pricing-Patch_test_1779391559621_e3ze2 |  |
| 3479 | QS-Pricing-Patch_test_1779460111881_ijtdv |  |
| 3839 | QS-Pricing-Guard_test_1779894080490_9oif8 |  |
| 3702 | QS-Pricing-Guard_test_1779830930353_ovi3o |  |
| 3703 | QS-Pricing-Patch_test_1779830931760_kayre |  |
| 3500 | QS-Pricing-Guard_test_1779478334290_mljbw |  |
| 3847 | QS-Pricing-Guard_test_1779902428624_7eww7 |  |
| 3973 | QS-Pricing-Patch_test_1779965792604_eih68 |  |
| 3856 | QS-Pricing-Patch_test_1779905311576_8kk9q |  |
| 4144 | QS-Pricing-Patch_test_1780047205271_w5g37 |  |
| 3719 | QS-Pricing-Patch_test_1779832765882_wa5a1 |  |
| 2106 | QS-Pricing-Patch_test_1778077613257_v0lbi |  |
| 3983 | QS-Pricing-Guard_test_1779967456338_k4smn |  |
| 3984 | QS-Pricing-Patch_test_1779967458886_mso4k |  |
| 4152 | QS-Pricing-Patch_test_1780053471793_kjypw |  |
| 3727 | QS-Pricing-Patch_test_1779836958404_dwndf |  |
| 3516 | QS-Pricing-Guard_test_1779481806737_sghwd |  |
| 3326 | QS-Pricing-Guard_test_1779285400842_mk9ue |  |
| 3872 | QS-Pricing-Patch_test_1779912485695_lh7x9 |  |
| 3743 | QS-Pricing-Patch_test_1779864018912_16qd7 |  |
| 3879 | QS-Pricing-Guard_test_1779913181816_6te8r |  |
| 3774 | QS-Pricing-Guard_test_1779884430138_2ei61 |  |
| 3903 | QS-Pricing-Guard_test_1779955754171_koxqe |  |
| 3911 | QS-Pricing-Guard_test_1779956519718_8kx2q |  |
| 3920 | QS-Pricing-Patch_test_1779958150985_c0ak4 |  |
| 3829 | QS-Pricing-Guard_test_1779890895207_0beh8 |  |
| 3635 | QS-Pricing-Patch_test_1779803377936_nn2xz |  |
| 3818 | QS-Pricing-Guard_test_1779890506981_co5u2 |  |
| 3642 | QS-Pricing-Guard_test_1779806202190_l5g46 |  |
| 3468 | QS-Pricing-Guard_test_1779454278010_c108c |  |
| 3945 | QS-Pricing-Guard_test_1779962845903_22ozn |  |
| 3480 | QS-Pricing-Guard_test_1779460136868_2ier9 |  |
| 4111 | QS-Pricing-Guard_test_1780003856150_kv844 |  |
| 3501 | QS-Pricing-Patch_test_1779478335583_8gy5k |  |
| 3840 | QS-Pricing-Patch_test_1779894081801_hz5gq |  |
| 3848 | QS-Pricing-Patch_test_1779902429916_scsd7 |  |
| 3710 | QS-Pricing-Guard_test_1779832099410_clxqy |  |
| 3972 | QS-Pricing-Guard_test_1779965790770_1emxk |  |
| 3974 | QS-Pricing-Patch_test_1779965792661_ev0wf |  |
| 4354 | QS-Pricing-Guard_test_1780136245275_f6aj8 |  |
| 3885 | QS-Pricing-Guard_test_1779913881361_4gcen |  |
| 3327 | QS-Pricing-Patch_test_1779285401979_3yb8h |  |
| 3767 | QS-Pricing-Guard_test_1779883779350_yx78q |  |
| 3333 | QS-Pricing-Guard_test_1779285562468_2n6lk |  |
| 3334 | QS-Pricing-Patch_test_1779285563467_jjmke |  |
| 3768 | QS-Pricing-Patch_test_1779883780634_lp10c |  |
| 3775 | QS-Pricing-Patch_test_1779884431300_ar0k3 |  |
| 3807 | QS-Pricing-Guard_test_1779888881418_2pswt |  |
| 3820 | QS-Pricing-Patch_test_1779890508796_xzycs |  |
| 3904 | QS-Pricing-Patch_test_1779955755391_1mnfg |  |
| 3830 | QS-Pricing-Patch_test_1779890897260_12k2v |  |
| 3912 | QS-Pricing-Patch_test_1779956520997_o663b |  |
| 3919 | QS-Pricing-Guard_test_1779958149752_tpchj |  |
| 3935 | QS-Pricing-Guard_test_1779960760856_lc4ue |  |
| 3469 | QS-Pricing-Patch_test_1779454279945_2hikz |  |
| 3946 | QS-Pricing-Patch_test_1779962847325_e86km |  |
| 3481 | QS-Pricing-Patch_test_1779460138178_4fq0r |  |
| 3953 | QS-Pricing-Guard_test_1779964230300_85y4z |  |
| 3954 | QS-Pricing-Patch_test_1779964231633_8fajf |  |
| 4112 | QS-Pricing-Patch_test_1780003857695_ziqkk |  |
| 4135 | QS-Pricing-Guard_test_1780037063570_q08g4 |  |
| 4023 | QS-Pricing-Guard_test_1779969740838_da318 |  |
| 4024 | QS-Pricing-Patch_test_1779969742245_a9lqt |  |
| 4136 | QS-Pricing-Patch_test_1780037064770_l8cxh |  |
| 4119 | QS-Pricing-Guard_test_1780031215695_mya5r |  |
| 4120 | QS-Pricing-Patch_test_1780031217060_bc55v |  |
| 4127 | QS-Pricing-Guard_test_1780031751799_fihv1 |  |
| 4128 | QS-Pricing-Patch_test_1780031753286_tmzt1 |  |
| 4031 | QS-Pricing-Guard_test_1779974162600_12t0b |  |
| 4032 | QS-Pricing-Patch_test_1779974164070_6ma8r |  |
| 4143 | QS-Pricing-Guard_test_1780047204189_8bx8a |  |
| 4151 | QS-Pricing-Guard_test_1780053470941_jsujg |  |
| 4039 | QS-Pricing-Guard_test_1779978733803_3ancv |  |
| 4040 | QS-Pricing-Patch_test_1779978735161_w3z3q |  |
| 4055 | QS-Pricing-Guard_test_1779989931235_x5u0o |  |
| 4056 | QS-Pricing-Patch_test_1779989932607_n211u |  |
| 4047 | QS-Pricing-Guard_test_1779988802621_nfdpt |  |
| 4048 | QS-Pricing-Patch_test_1779988804109_621ol |  |
| 4193 | QS-Pricing-Patch_test_1780105170574_yj2p4 |  |
| 4774 | QS-Audit-NoInvoice_test_1780371656530_jixhw |  |
| 4063 | QS-Pricing-Guard_test_1779992576815_2i8n2 |  |
| 4064 | QS-Pricing-Patch_test_1779992578623_yisdf |  |
| 4192 | QS-Pricing-Guard_test_1780105169603_j4mkf |  |
| 4071 | QS-Pricing-Guard_test_1779994984482_kv6r0 |  |
| 4072 | QS-Pricing-Patch_test_1779994985962_7cqdd |  |
| 4200 | QS-Pricing-Guard_test_1780105275231_ytdob |  |
| 4201 | QS-Pricing-Patch_test_1780105275881_tspo6 |  |
| 4079 | QS-Pricing-Guard_test_1779996305173_nhtbh |  |
| 4080 | QS-Pricing-Patch_test_1779996306600_80gla |  |
| 4093 | QS-Pricing-Guard_test_1779999201138_t9f4h |  |
| 4087 | QS-Pricing-Guard_test_1779998225502_w9bh0 |  |
| 4088 | QS-Pricing-Patch_test_1779998228727_z8uqr |  |
| 4094 | QS-Pricing-Patch_test_1779999203428_1296p |  |
| 4103 | QS-Pricing-Guard_test_1779999912276_x6i2k |  |
| 4104 | QS-Pricing-Patch_test_1779999914078_cn636 |  |
| 4355 | QS-Pricing-Patch_test_1780136245959_uh3ut |  |
| 4357 | QS-Audit-NoInvoice_test_1780136279126_vej8o |  |

## document_types — hart zu löschen (referenzlos)

_(keine)_

## document_types — zu deaktivieren (referenziert)

_(keine)_

## Dokumenttyp-Whitelist (SSoT, 22 echte Typen)

- Führerschein
- Arbeitsvertrag
- Arbeitsunterweisung
- Kundenvertrag
- Forderungsabtretung
- Datenschutzerklärung
- Erste Hilfe Zertifikat
- Führungszeugnis - einfach
- Führungszeugnis - erweitert
- Personenbeförderungsschein
- Schlüsselübergabeprotokoll
- Vollmacht
- Einwilligungserklärung
- Sonstiges Dokument
- Ärztliche Verordnung
- Pflegegradbescheid
- Betreuungsvertrag (Pflegekasse)
- Dienstleistungsvertrag (Selbstzahler)
- Datenschutzvereinbarung
- SEPA-Lastschriftmandat
- Abtretungserklärung
- Auskunftsvollmacht zur Budgetabfrage (SGB XI)
