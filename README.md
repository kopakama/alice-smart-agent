# Навык Алисы с LLM через Cloudflare Worker

Прослойка между навыком Яндекс Алисы и LLM-моделью. Сейчас используется `deepseek-v4.1-flash`
через сервис `ai.starimg.ru` (формат API — Anthropic `/v1/messages`).

**Как работает:** Алиса шлёт реплику → воркер спрашивает модель → если ответ пришёл за 2,5 с,
отдаёт сразу. Если нет — говорит «Секунду, думаю», досчитывает в фоне и кладёт ответ в KV;
следующая короткая реплика («ну», «ага», «давай») забирает ответ.

Код: `src/index.js` (он же `alice-claude-worker.js`).

---

## Требования

- Node.js + npm
- Аккаунт Cloudflare (бесплатный план)
- Ключ API сервиса `ai.starimg.ru`
- Навык в консоли Яндекс Диалогов

## Первый деплой с нуля

### 1. Создать проект

```powershell
npm create cloudflare@latest
```

- Directory: `my-worker`
- Start with: **Hello World example** → **Worker only** → **JavaScript**
- Deploy now: **No**

```powershell
cd my-worker
```

Если установка упала с `Cannot read properties of null (reading 'edgesOut')`:

```powershell
npm cache clean --force
npm install -g npm@latest
Remove-Item -Recurse -Force node_modules, package-lock.json -ErrorAction SilentlyContinue
npm install
```

### 2. Настроить `wrangler.jsonc`

Проверить, что нет заглушек вида `<...>`:

```jsonc
"name": "alice-claude",
"main": "src/index.js",
"compatibility_date": "2026-09-01",
```

### 3. Создать KV-хранилище для отложенных ответов

```powershell
npx wrangler kv namespace create ANSWERS
```

На вопрос про local dev — **N**. Добавить в `wrangler.jsonc` (если wrangler не добавил сам):

```jsonc
"kv_namespaces": [
  { "binding": "ANSWERS", "id": "<id из вывода команды>" }
],
```

### 4. Вставить код

Заменить всё содержимое `src/index.js` кодом воркера.

### 5. Записать ключ API

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Вставить ключ `ai.starimg.ru` без кавычек и пробелов. Проверка:

```powershell
npx wrangler secret list
```

### 6. Задеплоить

```powershell
npx wrangler deploy
```

В конце будет адрес: `https://alice-claude.<аккаунт>.workers.dev`

### 7. Подключить к Алисе

В консоли Яндекс Диалогов → навык → **Webhook URL** = адрес из шага 6.
Категория: «Поиск и быстрые ответы». Доступ: **приватный** (чтобы чужие не тратили токены).

---

## Обновление кода

```powershell
cd my-worker
npx wrangler deploy
```

Секрет и KV при этом не сбрасываются.

## Проверка без Алисы

```powershell
$body = '{"version":"1.0","session":{},"request":{"original_utterance":"сколько планет в солнечной системе"}}'
Invoke-RestMethod -Method Post -Uri https://alice-claude.<аккаунт>.workers.dev -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 5
```

## Логи

```powershell
npx wrangler tail --format pretty
```

Строки в логе:
- `Answered in N ms` — ответ получен за N мс
- `API error <код> <текст>` — сервис вернул ошибку (401 — ключ, 400 — модель/параметры)
- `API exception after N ms` — обрыв по таймауту

---

## Настройки в начале `src/index.js`

| Константа | Что это |
|---|---|
| `API_URL` | адрес API: `https://ai.starimg.ru/v1/messages` |
| `MODEL` | модель: `deepseek-v4.1-flash` |
| `INLINE_WAIT_MS` | сколько ждать ответ «вживую» (не больше ~2800 — лимит Алисы ~3 с) |
| `API_TIMEOUT_MS` | таймаут фонового запроса (не больше ~28000 — лимит Cloudflare 30 с) |
| `SHORT_REPLY_WORDS` | реплика из стольких слов и меньше забирает отложенный ответ |

## Смена модели или сервиса

1. Список моделей:
   ```powershell
   $key = "КЛЮЧ".Trim()
   (Invoke-RestMethod -Uri https://ai.starimg.ru/v1/models -Headers @{ "Authorization"="Bearer $key"; "x-api-key"=$key }).data | Select-Object id
   ```
2. Замерить скорость кандидатов (важно — у реселлеров скорость сильно плавает, мерить 2–3 раза).
3. Поменять `MODEL` (и `API_URL`, если другой сервис), при смене сервиса — `npx wrangler secret put ANTHROPIC_API_KEY`.
4. `npx wrangler deploy`.

Замеры на 28.09.2026 (сложный вопрос): `deepseek-v4.1-flash` ~2 с, `gpt-6-luna` 5–7 с,
`glm-5.3-flash` 4–8 с, `gpt-6-sol` 20–35 с.

## Частые проблемы

| Симптом | Причина |
|---|---|
| `error code: 1101` | воркер упал с исключением — смотреть `wrangler tail` |
| `API key is invalid` | не тот ключ в секрете или не тот `API_URL` |
| `Unsupported model` | такой модели у сервиса нет — проверить `/v1/models` |
| Кракозябры в ответе в PowerShell | только отображение в PowerShell 5, Алисе приходит нормально |
| Команда PowerShell падает с `Get-Process` | скопировали приглашение `PS C:\...>` вместе с командой |
| «Секунду, думаю» слишком часто | сервис медленный — замерить и сменить модель |

Cloudflare Workers Free: 100 000 запросов в день. KV Free: 1000 записей в день (≈ 300–500 медленных вопросов).
