# PUDRA → Provecta MCP

Это read-only коннектор, чтобы ChatGPT мог сам читать свежие данные FAMILYTURCOMPANY из Provecta без PUDRA CONTROL и без ручной выгрузки Excel.

## Что умеет

- проверять подключение к Provecta;
- получать филиалы и склады;
- искать товары по названию / штрихкоду / коду;
- получать текущие остатки;
- читать документы и строки документов за период;
- считать продажи и ТОП товаров за день/период;
- отдавать данные ChatGPT для заявок, перемещений, ABC/остатков и другой аналитики.

Важно: внешний API Provecta read-only. Коннектор ничего не записывает в Provecta и не создаёт приход/перемещение. Заявки и рекомендации ChatGPT формирует на основе прочитанных данных.

## Переменные окружения

Обязательные:

- `PROVECTA_USERNAME` — логин Provecta.
- `PROVECTA_PASSWORD` — пароль Provecta.
- `MCP_ACCESS_TOKEN` — длинный случайный секрет для защиты самого MCP endpoint.

Обычно не менять:

- `PROVECTA_BASE_URL=https://provectapos.com/proxy/api`
- `PROVECTA_SALE_OPERATION=OutcomeRegular`

Если Provecta вернёт несколько client UUID, можно явно задать `PROVECTA_CLIENT_ID`.

## Развёртывание

Проект готов для Railway. После публикации MCP URL будет:

`https://<ваш-домен>/mcp`

При добавлении custom MCP server в ChatGPT укажите этот URL и Bearer token из `MCP_ACCESS_TOKEN`.

## Первичная проверка

После подключения в ChatGPT сначала вызовите `connection_status`. Он должен показать реальные филиалы FAMILYTURCOMPANY. Затем запросите `recent_documents` за один день и сверим тип розничной продажи. По умолчанию используется `OutcomeRegular`; если у вашей базы Provecta другой тип, достаточно поменять одну переменную окружения.

## Безопасность

Пароль Provecta и MCP_ACCESS_TOKEN не записаны в исходники. Храните их только в Secrets/Variables хостинга. Не присылайте пароль в чат.
