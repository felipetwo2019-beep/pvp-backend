# Etheria Multiplayer 1v1

Este projeto adapta o **GAME.html** para multiplayer 1v1 online com Node.js + Socket.io.

## Como rodar

```bash
npm install
npm start
```

Abra o jogo em `http://localhost:3000`.

## Como testar

1. Abra duas abas (uma pode ser janela anônima).
2. Em cada aba, monte seu deck no **Deck Builder** e avance para o lobby.
3. Crie uma sala em uma aba e entre nela pela outra.
4. Ambos clicam em **PRONTO** para iniciar.

## Fluxo de telas

- Menu → Deck Builder → Lobby → Sala → Campo de batalha.

## Observações

- O servidor é responsável por receber intents e distribuir o estado.
- O cliente apenas renderiza o estado, envia intents e executa efeitos visuais.
