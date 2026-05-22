# Автоматизация расчета СС

Google Apps Script web app для создания копии базовой таблицы расчета себестоимости из Bitrix24.

## Что делает скрипт

- принимает `dealId` из Bitrix24;
- получает название сделки через Bitrix24 REST API;
- создает или переиспользует папку сделки в Google Drive;
- копирует базовую таблицу расчета СС;
- выдает новой таблице имя с номером сделки, датой и версией;
- автоматически разрешает `IMPORTRANGE` для нужных таблиц-источников;
- скрывает старый служебный лист `🚜` в созданной копии;
- записывает ссылку на расчет в UF-поле сделки;
- создает элемент КП в разделе Bitrix24.

## Настройки

Основные идентификаторы лежат в `CONFIG` в `Code.gs`.

Bitrix webhook не хранится в репозитории. Его нужно задать в Script Properties:

```text
BITRIX_WEBHOOK_BASE=https://example.bitrix24.ru/rest/1/xxxxxxxxxxxx
```

## Текущий Apps Script

```text
scriptId: 1aHGH9vC0qiyElLtOmMlmHwLK8IXz_0_RuzJh0pzvpvpmvJ1k7dNFFUXZ
```

## Деплой

При использовании `clasp`:

```bash
clasp login
clasp push
clasp deploy
```

После деплоя проверьте web app URL в настройках развертывания Apps Script.
