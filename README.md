# context-bar

Тонкая строка над полем ввода Claude Code (десктоп и терминал):

```
▬▬▬▬▬▭▭▭▭▭  42%  84k / 200k  ·  лимит 23%, сброс через 2ч 14м        ● Remote
```

- заполнение контекста: полоска, процент и токены; красная от 80%
- лимит за 5 часов и время до сброса
- тумблер Remote Control: серый — выключен, жёлтый — подключается, зелёный — включён

## Установка

В терминальной сессии Claude Code:

```
/plugin install context-bar --marketplace maksutovnurda/claude-context-bar
```

Из шелла:

```
claude plugin install context-bar --marketplace maksutovnurda/claude-context-bar
```

В десктопном приложении: + рядом с полем ввода → Plugins → Add marketplace `maksutovnurda/claude-context-bar` → Add plugin.

## Тумблер Remote в десктопе

В auto-режиме нажатие кнопки отклоняется, пока нет правила разрешения. Добавьте в `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__ccd_session_mgmt__set_remote_control"] } }
```
