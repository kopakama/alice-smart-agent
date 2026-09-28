# CLAUDE.md — навык Яндекс Алисы с LLM через Cloudflare Worker

## Что это

Прослойка (webhook) между приватным навыком Яндекс Алисы и LLM. Алиса шлёт реплику POST-запросом
в формате Яндекс Диалогов → воркер спрашивает модель → возвращает ответ в формате Алисы.

- Воркер: Cloudflare Workers (бесплатный план), имя `alice-claude`, адрес `https://alice-claude.<аккаунт>.workers.dev`
- Код: `src/index.js` (один файл, без зависимостей)
- Конфиг: `wrangler.jsonc`
- Инструкция по деплою: `README.md`
- Навык в Яндекс Диалогах: приватный, категория «Поиск и быстрые ответы», Webhook URL = адрес воркера

## Текущая конфигурация

- LLM-сервис: реселлер `https://ai.starimg.ru/v1` (формат Anthropic `/v1/messages`; OpenAI `/v1/chat/completions` тоже работает)
- Модель: `deepseek-v4.1-flash`
- Ключ: секрет `ANTHROPIC_API_KEY` (имя историческое, внутри ключ ai.starimg.ru). Ключ шлётся и как `x-api-key`, и как `Authorization: Bearer`
- KV-хранилище: привязка `ANSWERS`

## Архитектура `src/index.js`

1. **Гибридный ответ.** Запрос к модели гонится с таймером `INLINE_WAIT_MS` (2500 мс).
   Успела — ответ сразу. Не успела — пишем в KV `a:<uid>` = `{status:"pending"}`, отвечаем
   «Секунду, думаю», досчитываем в `ctx.waitUntil` и кладём `{status:"done", text}`.
   Следующая короткая реплика (≤ `SHORT_REPLY_WORDS` = 3 слов) забирает ответ.
2. **Память диалога.** KV `h:<uid>` — последние `HISTORY_MESSAGES` (10) сообщений, TTL сутки.
3. **Долгосрочные факты.** KV `f:<uid>` — массив строк без TTL, до `MAX_FACTS` (30).
   Подставляются в system prompt.
4. **uid** = `session.user.user_id` → `session.application.application_id` → `session.session_id`.
5. **Голосовые команды:** «запомни, что …», «что ты обо мне знаешь», «забудь всё обо мне»
   (факты), «забудь» / «новая тема» (только диалог). Сравнение после `normalize()` (нижний регистр, ё→е, без пунктуации).
6. System prompt: короткие ответы 1–3 предложения, по-русски, без markdown/списков/эмодзи (это озвучивается).

## Жёсткие ограничения (не нарушать)

- **Алиса ждёт ответ ~3 с.** `INLINE_WAIT_MS` не больше ~2800. Если воркер не ответит — Алиса скажет «навык не отвечает».
- **Навык не может говорить сам** — только отвечать на реплику. Отсюда схема с «ну / ага».
- **Cloudflare `waitUntil` живёт ≤ 30 с после ответа.** `API_TIMEOUT_MS` не больше ~28000.
- **Workers Free:** 100k запросов/день, 10 мс CPU на вызов (ожидание fetch не считается).
- **KV Free:** 1000 записей/день. Сейчас ~1–3 записи на вопрос.
- **Текст ответа Алисы** ≤ 1024 символа.
- **Anthropic API напрямую недоступен** (пользователь в России, регион не поддерживается) — поэтому реселлер.
  Обходить региональную блокировку через прокси не делаем.
- Ответ всегда с заголовком `Content-Type: application/json; charset=utf-8`.

## Замеры скорости (ai.starimg.ru, сложный вопрос, 28.09.2026)

| Модель | Время |
|---|---|
| deepseek-v4.1-flash | ~2 с ✅ |
| glm-5.3-flash | 4–8 с |
| gpt-6-luna | 5–7 с (на простых ~1.6 с, но плавает до 10–12 с) |
| gpt-6-sol | 20–35 с |
| claude-* (все) | 20–30 с — не годятся |
| gemini-3.8-flash | ошибка |

Скорость у реселлеров сильно плавает — мерить 2–3 раза. `output_config: {effort: "low"}` сервис принимает,
но для DeepSeek эффекта нет. Пользователь интересовался `deepseek-v4-pro` — ещё не замерена.

Ранее пробовали реселлер `claude-n-codex.com:8443` (только Claude/Fable/Opus/Sonnet, без Haiku;
Opus 5 ~4 с, Fable 5.1 ~4–6 с, Sonnet 25–44 с) — отказались из-за скорости.

## Окружение пользователя

- Windows, **PowerShell 5** — важно:
  - `curl` с JSON ломается на кавычках и кириллице → использовать `Invoke-RestMethod` с телом
    `([System.Text.Encoding]::UTF8.GetBytes($body))`
  - кириллица в ответе может отображаться кракозябрами — это только вывод PowerShell
  - ключи в заголовках: сначала `$key = "...".Trim()`, иначе «недопустимые знаки управления»
  - не копировать приглашение `PS C:\...>` вместе с командой (`PS` = `Get-Process`)
- Проект лежит в `E:\downloads\my-worker`
- Пользователь — фронтенд-разработчик (React), с JS/TS свободно

## Команды

```powershell
npx wrangler deploy                       # деплой
npx wrangler tail --format pretty         # живые логи
npx wrangler secret put ANTHROPIC_API_KEY # сменить ключ
npx wrangler secret list
```

Лог-строки воркера: `Answered in N ms`, `API error <код> <тело>`, `API exception after N ms`.

Тест без Алисы:

```powershell
$body = '{"version":"1.0","session":{},"request":{"original_utterance":"сколько планет в солнечной системе"}}'
Invoke-RestMethod -Method Post -Uri https://alice-claude.<аккаунт>.workers.dev -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 5
```

## Возможные следующие шаги

- Замерить `deepseek-v4-pro`; если ≤ 2.5 с — переключить `MODEL`
- Логировать расход токенов (`usage` из ответа API)
- Автоматически извлекать факты из диалога, а не только по «запомни»
- Если реселлер отвалится — достаточно поменять `API_URL`, `MODEL` и секрет
