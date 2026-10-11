# Serie "SABÍAS QUE… TABÚ" — detalle de los 6 videos

Fuente creativa de P-002 y de la investigación de P-001. Los **claims marcados `VERIFICAR`** son
candidatos: P-001 los confirma con fuente o los reemplaza. Ningún dato entra al guion sin `facts.json`.

## Identidad de serie (`series.json`)
```json
{
  "schemaVersion": 1,
  "serie": "sabias-que-tabu",
  "product": "serie-sabias-que",
  "format": { "width": 1080, "height": 1920, "fps": 30, "minSeconds": 45, "maxSeconds": 60 },
  "palette": ["#0B0B0F", "#F5F1E8", "#FF3B2F", "#FACC15"],
  "voice": { "language": "es-419", "tone": "cercano, intrigante, sin hype", "voiceId": "RESOLVER-EN-P-002" },
  "sello": "SABÍAS QUE?",
  "videos": [
    { "order": 1, "slug": "cuerpo-despues-de-morir",   "generated": true  },
    { "order": 2, "slug": "cuentas-no-mueren",         "generated": false },
    { "order": 3, "slug": "lo-que-saben-de-ti",        "generated": true  },
    { "order": 4, "slug": "precio-escondido",          "generated": false },
    { "order": 5, "slug": "nadie-te-enseno-a-leer",    "generated": false },
    { "order": 6, "slug": "cuerpo-traiciona-dormido",  "generated": true  }
  ]
}
```

Reglas de motion de la serie: cada 1–2 s entra un elemento (número que cuenta, línea que se escribe,
objeto que reacciona, dato que se resalta); el movimiento acompaña la semántica; corte seco en el hook
y remate con la marca; subtítulos con `WordSubtitles` (nunca pegados al borde inferior).

---

## 1 · `cuerpo-despues-de-morir` — "Tu cuerpo no muere de golpe"
- **Hook (0–2 s):** pantalla negra, un latido que se corta → tipografía escribe: *"A las 3 horas de morir, tu cuerpo todavía se mueve."*
- **Promesa:** la muerte no es un interruptor, es un proceso de horas.
- **Tabú/viral:** morbo por la muerte, educado en vez de explotado (platform-safe).
- **B-roll generado:** sí — laboratorio/tanatorio estilizado, figura humana esquemática (sin gore).

**Escenas (`video.json`)**
| id | intent | source | narration (resumen) | caption |
|---|---|---|---|---|
| `hook` | title-motion | motion | "A las tres horas de morir, el cuerpo todavía se mueve." | La muerte no es un interruptor. |
| `linea-tiempo` | data-motion | motion | "Palidez, enfriamiento, rigidez, livideces: cada etapa tiene nombre." | Cinco etapas, cinco nombres. |
| `bacterias` | number-motion | motion | "En ese tiempo, tus bacterias empiezan a trabajar." | El cuerpo se transforma desde dentro. |
| `cierre` | outro-motion | motion | "Y aun así, tu cuerpo puede seguir ayudando a otros." | A veces, un final es un comienzo. |

- **Prompt fal (fondo):** "tanatorio/laboratorio minimalista, luz fría cenital, silueta esquemática sobre mesa, estética científica, sin sangre, sin gore, 9:16, cinematográfico, alto contraste".
- **Cover:** "TU CUERPO NO MUERE DE GOLPE" + sello.
- **Publicación:** título "¿Qué pasa con tu cuerpo en las 3 horas después de morir?"; descripción 2–3 líneas + disclaimer "contenido educativo, sin imágenes explícitas"; hashtags: `#sabiasque #muerte #ciencia #curiosidades #tabu`.
- **Claims `VERIFICAR`:** etapas post mortem `pallor/algor/rigor/livor mortis` y ventanas temporales; donación de órganos tras muerte. Fuentes candidatas: NIH/NCBI, textos forenses. **Fuente → facts.json.**

---

## 2 · `cuentas-no-mueren` — "Tus cuentas no mueren contigo"
- **Hook (0–2 s):** perfil en gris; escribe *"Última conexión: hace 9 años"*.
- **Promesa:** tus redes siguen publicando, cobrando y sugiriendo amistades cuando ya no estás.
- **Tabú/viral:** muerte digital + privacidad.
- **B-roll generado:** no — UI mockup 100% Remotion.

**Escenas**
| id | intent | source | narration | caption |
|---|---|---|---|---|
| `hook` | ui-motion | motion | "Esta cuenta lleva nueve años sin conectarse… y sigue apareciendo." | No todo perfil muere con la persona. |
| `automatiza` | ui-motion | motion | "Publicaciones programadas, cobros de suscripción, amigos sugeridos." | La máquina no se enteró. |
| `opciones` | list-motion | motion | "Memorializar, heredar o borrar: existen opciones." | Tú decides qué queda. |
| `cierre` | outro-motion | motion | "Tus cuentas son un testamento que nadie escribió." | Un testamento sin firmar. |

- **Cover:** "TUS CUENTAS NO MUEREN CONTIGO".
- **Publicación:** título "Qué pasa con tus redes sociales cuando mueres"; hashtags `#sabiasque #privacidad #redessociales #curiosidades #tabu`.
- **Claims `VERIFICAR`:** políticas de cuenta memorial de las plataformas (Instagram/Facebook/Google) **a la fecha**; opciones de borrado/herencia. Citar la fuente oficial y su fecha.

---

## 3 · `lo-que-saben-de-ti` — "Lo que ya saben de ti"
- **Hook (0–2 s):** *"En este segundo, alguien sabe dónde vives, con quién duermes y qué te da vergüenza."*
- **Promesa:** tu huella digital contada como vigilancia en vivo.
- **Tabú/viral:** privacidad y big tech (**sin acusar marcas concretas sin prueba**).
- **B-roll generado:** sí — ciudad nocturna, lluvia de datos.

**Escenas**
| id | intent | source | narration | caption |
|---|---|---|---|---|
| `hook` | title-motion | motion | "Cada clic deja un rastro." | No eres el producto. |
| `rastro` | data-motion | motion | "IP, ubicación, horarios, contactos, gustos." | Eres la materia prima. |
| `modelo` | diagram-motion | motion | "Con suficientes datos, tu comportamiento se predice." | Te conocen antes de que decidas. |
| `cierre` | outro-motion | motion | "La pregunta no es si te vigilan, sino qué aceptaste sin leer." | ¿Leíste la letra chica? |

- **Prompt fal:** "ciudad nocturna vista aérea, estrellas de datos conectando edificios, azul frío, lluvia fina, 9:16, cinematográfico".
- **Cover:** "LO QUE YA SABEN DE TI".
- **Publicación:** título "¿Cuánto saben de ti sin que lo notes?"; hashtags `#sabiasque #privacidad #datos #internet #tabu`.
- **Claims `VERIFICAR`:** existencia de la "página de actividad" de Google y qué guarda; categorías de datos recogidos (con fuente oficial). No afirmar cifras específicas sin fuente.

---

## 4 · `precio-escondido` — "El precio te lo escondieron en 3 lugares"
- **Hook (0–2 s):** ticket de `$9.99` que sube solo hasta `$23.47` en cámara.
- **Promesa:** dark patterns de suscripción y precios psicológicos.
- **Tabú/viral:** dinero + manipulación (**hablar de patrones, no de una empresa**).
- **B-roll generado:** no — tipografía + UI mockup.

**Escenas**
| id | intent | source | narration | caption |
|---|---|---|---|---|
| `hook` | counter-motion | motion | "El precio no era nueve noventa y nueve." | El precio real está más abajo. |
| `cargos` | list-motion | motion | "Cargo de servicio, renovación automática, la 'prueba gratis' que no lo era." | Tres lugares, siempre los mismos. |
| `cancelar` | ui-motion | motion | "Y para cancelar, el botón se esconde." | Suscribirte: 1 clic. Cancelar: 7. |
| `cierre` | outro-motion | motion | "La ley te protege… si sabes que existe." | Pregunta antes de pagar. |

- **Cover:** "EL PRECIO TE LO ESCONDIERON".
- **Publicación:** título "Las 3 trampas de precio que casi nadie revisa"; hashtags `#sabiasque #dinero #consumidor #internet #tabu`.
- **Claims `VERIFICAR`:** normas de cancelación/suscripción por jurisdicción (p. ej. FTC "click-to-cancel" y su estado; UE). **Fechar y juridiscción en facts.json.** Sin nombrar empresas reales.

---

## 5 · `nadie-te-enseno-a-leer` — "Nadie te enseñó a leer esto"
- **Hook (0–2 s):** términos y condiciones en scroll acelerado → *"Aceptaste sin leer. Y firmaste más que datos."*
- **Promesa:** cláusulas absurdas que sí existieron.
- **Tabú/viral:** conocimiento prohibido / letra chica.
- **B-roll generado:** no — documentos, sellos y texturas.

**Escenas**
| id | intent | source | narration | caption |
|---|---|---|---|---|
| `hook` | doc-motion | motion | "Nadie lee los términos. Pero todos firman." | El contrato más largo del mundo. |
| `clausula` | highlight-motion | motion | "Y en medio, cláusulas que nadie esperaría." | El diablo está en la letra chica. |
| `cambio` | stamp-motion | motion | "'Nos reservamos el derecho de cambiar estos términos.'" | Firmaste algo que puede cambiar. |
| `cierre` | outro-motion | motion | "La próxima vez, baja hasta el final." | Diez segundos de scroll. |

- **Cover:** "NADIE TE ENSEÑÓ A LEER ESTO".
- **Publicación:** título "Cláusulas que aceptaste sin leer"; hashtags `#sabiasque #contratos #internet #consumidor #tabu`.
- **Claims `VERIFICAR`:** caso documentado de cláusula de "alma inmortal" (concurso 2010, fuente de prensa/directa) y/o otras cláusulas documentadas. **Solo casos con fuente citada en pantalla.**

---

## 6 · `cuerpo-traiciona-dormido` — "Tu cuerpo te traiciona mientras duermes"
- **Hook (0–2 s):** silueta inmóvil en la cama → *"Estás despierto. No puedes moverte. Y no estás solo."*
- **Promesa:** parálisis del sueño y alucinaciones hipnagógicas.
- **Tabú/viral:** terror + cuerpo. Se abre y cierra con "es normal y tiene explicación" (sin consejo médico).
- **B-roll generado:** sí — cuarto en penumbra, figura sugerida (nunca mostrada).

**Escenas**
| id | intent | source | narration | caption |
|---|---|---|---|---|
| `hook` | title-motion | motion | "Tu mente despierta. Tu cuerpo, dormido." | El interruptor se queda a medias. |
| `ondas` | data-motion | motion | "En sueño REM, el cerebro apaga tus músculos." | Por eso no actuás tus sueños. |
| `figura` | media-frame | fal-video | "Si el interruptor falla, la mente alucina." | La figura está en tu cabeza. |
| `cierre` | outro-motion | motion | "Es normal, tiene nombre y pasa." | No estás solo: le pasa a millones. |

- **Prompt fal:** "dormitorio en penumbra, silueta inmóvil bajo sábanas, luz de luna por la ventana, atmósfera inquietante sin blood, 9:16, cinematográfico; figura en el marco de la puerta sugerida, desenfocada, nunca mostrada".
- **Cover:** "TU CUERPO TE TRAICIONA DORMIDO".
- **Publicación:** título "Por qué no puedes moverte al despertar"; hashtags `#sabiasque #sueño #paralisisdelsueño #cerebro #tabu`.
- **Claims `VERIFICAR`:** atonía muscular en REM, prevalencia de parálisis del sueño, alucinaciones hipnagógicas (NIH/NCBI, revisión con fecha). **Nada de consejo médico.**

---

## Cierre de serie
Los seis comparten sello de apertura, paleta y tipografía, y cierre "¿Sabías que…? Sígueme para más."
Cada `publication/<slug>.draft.json` lleva `discloseSyntheticMedia: true` cuando haya media generada.
