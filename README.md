# Навык Алисы с LLM через Cloudflare Worker

Прослойка между навыком Яндекс Алисы и LLM-моделью. Сейчас используется `deepseek-v4.1-flash`
через сервис `ai.starimg.ru`. Подойдёт любой сервис с API в формате Anthropic `/v1/messages`:
адрес и модель задаются в `wrangler.jsonc` (с `api.anthropic.com` напрямую не проверялось).

**Как работает:** Алиса шлёт реплику → воркер спрашивает модель → если ответ пришёл за 2,5 с,
отдаёт сразу. Если нет — говорит «Секунду, думаю», досчитывает в фоне и кладёт ответ в KV;
реплика-подтверждение («ну», «ага», «и что», «готово»…) забирает ответ.

Что ещё умеет:
- помнит последние реплики диалога (сутки) и факты о пользователе («запомни, что…», бессрочно);
- команды: «что ты обо мне знаешь», «забудь всё обо мне», «забудь» / «новая тема», «помощь», «пока»;
- лимит вопросов к модели на пользователя в сутки (по умолчанию 100);
- чистит ответ модели от markdown и эмодзи, не обрывает фразу на полуслове, повторяет запрос при сбое сервиса.

Код: `src/index.js` (один файл, без зависимостей). Тесты: `test/index.spec.js`.

---

## Что нужно

- Node.js 22+ и npm, git
- Аккаунт Cloudflare (бесплатного плана хватает)
- Ключ API сервиса модели (сейчас — `ai.starimg.ru`)
- Навык в консоли Яндекс Диалогов (тип «Навык в Алисе»)

## Установка

Команды ниже — для PowerShell, но работают и в любом другом терминале.

### 1. Получить код

Форкнуть репозиторий на GitHub (нужно для автодеплоя) и склонировать свой форк:

```powershell
git clone https://github.com/<вы>/alice-smart-agent
cd alice-smart-agent
npm install
npx wrangler login
```

Если `npm install` упал с `Cannot read properties of null (reading 'edgesOut')`:

```powershell
npm cache clean --force
npm install -g npm@latest
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
npm install
```

### 2. Создать своё KV-хранилище

```powershell
npx wrangler kv namespace create ANSWERS
```

На вопрос про local dev — **N**. Из вывода взять `id`.

### 3. Вписать свои значения в `wrangler.jsonc`

В репозитории лежат значения автора — их **обязательно** заменить, иначе деплой упадёт
(чужой KV) или навык будет отвечать 403 (чужой `SKILL_ID`):

```jsonc
"vars": {
	"SKILL_ID": "<id вашего навыка из консоли Диалогов>",  // или удалить строку — тогда без проверки
	"API_URL": "https://ai.starimg.ru/v1/messages",
	"MODEL": "deepseek-v4.1-flash"
},
"kv_namespaces": [
	{ "binding": "ANSWERS", "id": "<id из шага 2>" }
]
```

`name` (`alice-claude`) можно оставить или поменять — от него зависит адрес воркера.

### 4. Записать ключ API

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Вставить ключ без кавычек и пробелов. Проверка: `npx wrangler secret list`.

### 5. Задеплоить

```powershell
npx wrangler deploy
```

В конце будет адрес: `https://alice-claude.<аккаунт>.workers.dev`

### 6. Подключить к Алисе

В консоли Яндекс Диалогов → навык → **Webhook URL** = адрес из шага 5.
Категория: «Поиск и быстрые ответы». Доступ: **приватный** (чтобы чужие не тратили токены).

### 7. (Рекомендуется) Закрыть воркер секретным путём

Без этого воркер отвечает на любой POST, и кто узнал адрес, может тратить ваш баланс.

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLower()
npx wrangler secret put WEBHOOK_SECRET
```

Первая команда генерирует секрет (нужен PowerShell 7+; в Windows PowerShell 5 подойдёт
`-join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })`), вторая сохраняет его в Cloudflare. После этого воркер отвечает только
на `POST /<секрет>` (остальное — 404), поэтому сразу поменять Webhook URL на `https://alice-claude.<аккаунт>.workers.dev/<секрет>`.
Выключить: `npx wrangler secret delete WEBHOOK_SECRET` и вернуть Webhook URL без суффикса.

---

## Автодеплой (GitHub Actions)

При каждом пуше в `master` `.github/workflows/deploy.yml` прогоняет тесты и, если они прошли, деплоит воркер.

Настроить один раз:
1. В форке открыть вкладку **Actions** и включить workflows (в форках они выключены по умолчанию).
2. **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` — dash.cloudflare.com → My Profile → API Tokens → шаблон «Edit Cloudflare Workers»;
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare → Workers & Pages, справа на странице.
3. Запустить вручную: Actions → Deploy → **Run workflow**, или просто запушить.

Секреты воркера (`ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`) хранятся в Cloudflare, в GitHub их класть не нужно.
Без автодеплоя обновлять вручную: `npx wrangler deploy` — секреты и KV при этом не сбрасываются.

Если деплой сломал навык — откатиться на прошлую версию: `npx wrangler rollback`.

## Локальный запуск и тесты

```powershell
Copy-Item .dev.vars.example .dev.vars   # вписать ключ в .dev.vars
npm run dev                             # воркер на http://localhost:8787
npx vitest run                          # тесты, модель не вызывают
```

## Проверка без Алисы

```powershell
$url  = "https://alice-claude.<аккаунт>.workers.dev/<WEBHOOK_SECRET>"   # без секрета — без /<...>
$body = '{"version":"1.0","session":{"skill_id":"<SKILL_ID>","session_id":"test"},"request":{"original_utterance":"сколько планет в солнечной системе"}}'
Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 5
```

`skill_id` должен совпадать с `SKILL_ID` из `wrangler.jsonc` (если он задан). Вопрос тратит один запрос к модели.

## Логи

```powershell
npx wrangler tail --format pretty
```

История — в дашборде: Cloudflare → Workers & Pages → alice-claude → Logs.

Строки в логе:
- `Answered in N ms, model …` — ответ получен за N мс
- `API error <код> <текст>` — сервис вернул ошибку (401 — ключ, 400 — модель/параметры)
- `API exception after N ms` — обрыв по таймауту или сети
- `KV put failed` — кончился дневной лимит записей KV

---

## Настройки в `wrangler.jsonc` (`vars`)

Меняются без правки кода: поправить значение → пуш в `master` (автодеплой).

| Переменная | Что это |
|---|---|
| `API_URL` | адрес API: `https://ai.starimg.ru/v1/messages` |
| `MODEL` | модель: `deepseek-v4.1-flash` |
| `SKILL_ID` | id навыка в Яндекс Диалогах; запросы с другим id получают 403 (удалить — проверки не будет) |
| `DAILY_LIMIT` | вопросов к модели в сутки на пользователя, по умолчанию 100, `0` — без лимита |

Если переменной нет, берётся значение по умолчанию из начала `src/index.js`.

## Настройки в начале `src/index.js`

| Константа | Что это |
|---|---|
| `INLINE_WAIT_MS` | сколько ждать ответ «вживую» (не больше ~2800 — лимит Алисы ~3 с) |
| `API_TIMEOUT_MS` | таймаут на все попытки запроса к модели (не больше ~28000 — лимит Cloudflare 30 с) |
| `FOLLOW_UP` | реплики, которыми забирают отложенный ответ («ну», «ага»…) |

## Смена модели или сервиса

1. Список моделей:
   ```powershell
   $key = "КЛЮЧ".Trim()
   (Invoke-RestMethod -Uri https://ai.starimg.ru/v1/models -Headers @{ "Authorization"="Bearer $key"; "x-api-key"=$key }).data | Select-Object id
   ```
2. Замерить скорость кандидатов (важно — у реселлеров скорость сильно плавает, мерить 2–3 раза).
3. Поменять `MODEL` (и `API_URL`, если другой сервис) в `vars` в `wrangler.jsonc`, при смене сервиса — `npx wrangler secret put ANTHROPIC_API_KEY`.
4. Закоммитить и запушить в `master` — задеплоится автоматически (или вручную `npx wrangler deploy`).

Замеры на 28.09.2026 (сложный вопрос): `deepseek-v4.1-flash` ~2 с, `gpt-6-luna` 5–7 с,
`glm-5.3-flash` 4–8 с, `gpt-6-sol` 20–35 с.

## Частые проблемы

| Симптом | Причина |
|---|---|
| Деплой: `KV namespace … not found` | в `wrangler.jsonc` чужой `id` KV — создать свой (шаг 2) |
| Воркер отвечает `403 forbidden` | `SKILL_ID` в `wrangler.jsonc` не совпадает с id навыка |
| Воркер отвечает `404 not found` | включён `WEBHOOK_SECRET`, а в URL нет секретного пути (или это GET) |
| Автодеплой красный на шаге Deploy | не добавлены `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` в GitHub |
| `error code: 1101` | воркер упал с исключением — смотреть `wrangler tail` |
| `API key is invalid` | не тот ключ в секрете или не тот `API_URL` |
| `Unsupported model` | такой модели у сервиса нет — проверить `/v1/models` |
| Кракозябры в ответе в PowerShell | только отображение в PowerShell 5, Алисе приходит нормально |
| Команда PowerShell падает с `Get-Process` | скопировали приглашение `PS C:\...>` вместе с командой |
| «Секунду, думаю» слишком часто | сервис медленный — замерить и сменить модель |
| «На сегодня лимит вопросов исчерпан» | поднять `DAILY_LIMIT` или поставить `0` |

Cloudflare Workers Free: 100 000 запросов в день. KV Free: 1000 записей в день (≈ 300–500 вопросов на всех).
