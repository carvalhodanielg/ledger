    Ledger — partidas dobradas com simulador de Pix
    O que é, em uma frase

    Um motor contábil de partida dobrada onde é estruturalmente impossível uma transação ficar desbalanceada, com uma camada de simulação de Pix por cima para dar contexto de produto reconhecível.

    O problema que ele resolve

    Todo sistema que mexe com dinheiro — carteira digital, marketplace, fintech — precisa responder uma pergunta simples que é traiçoeira de garantir: "quanto cada conta tem, e como eu tenho certeza que esse número está certo mesmo sob concorrência?"

    A abordagem ingênua é uma coluna saldo na tabela de contas que você incrementa e decrementa. Ela quebra de duas formas: (1) sob concorrência, dois updates simultâneos podem se sobrepor e um "vencer" sobre o outro, perdendo dinheiro; (2) não existe trilha de auditoria — se o saldo está errado, você não tem como reconstruir como ele ficou errado.

    A resposta contábil, usada há séculos antes de existir banco de dados, é a partida dobrada: todo evento financeiro é registrado como pelo menos duas entradas que somam zero — um débito em algum lugar é sempre um crédito em outro. Saldo nunca é um campo, é a soma de tudo que aconteceu até agora. Isso é auditável, é imutável, e é impossível ficar inconsistente se você aplicar a regra corretamente.

    Modelo de dados

    Quatro tabelas carregam o núcleo:

    accounts — as contas do sistema. Não são só contas de usuário: sua carteira também precisa de contas internas (a "conta da casa" que representa dinheiro entrando de fora do sistema, uma conta de taxas, uma conta de suspense para dinheiro em trânsito). Cada conta tem um tipo (user, house, fee, suspense) e uma moeda.

    transactions — o envelope de um evento de negócio: "Fulano transferiu R$ 50 pra Beltrano". Tem um id, uma idempotency_key única, um status (pending, posted, reversed), timestamp, e metadados livres (tipo, descrição).

    entries — as linhas de partida dobrada dentro de uma transação. Cada entry tem transaction_id, account_id, direction (debit ou credit) e amount (sempre positivo — o sinal vem da direção, nunca de número negativo). A regra de ouro do sistema, garantida em código e idealmente também em constraint de banco: a soma dos débitos de uma transação tem que ser igual à soma dos créditos, sempre.

    balances (opcional, mas vale ter) — não é fonte de verdade, é uma projeção: uma tabela materializada que cacheia o saldo corrente de cada conta pra não precisar somar milhões de entries toda vez que alguém consulta. Ela é recalculável a qualquer momento a partir das entries — se ela e a soma das entries divergirem um dia, você sabe que tem bug, e é exatamente esse recálculo que vira sua rotina de reconciliação.

    Uma unidade de dinheiro é sempre um inteiro em centavos, nunca float. Isso não é estilo, é correção — ponto flutuante binário não representa décimos de centavo exatamente, e um sistema financeiro com erro de arredondamento acumulado é um sistema quebrado.

    As duas camadas do sistema

    Camada 1 — o motor de ledger (o núcleo que importa de verdade)

    POST /transactions — cria uma transação com N entries. Rejeita se não balancear. Atômica: ou grava tudo ou não grava nada.
    GET /accounts/:id/balance — soma as entries daquela conta (ou lê a projeção).
    GET /accounts/:id/statement — extrato: lista de entries ordenadas por tempo, com saldo corrente calculado incrementalmente — essa é a tela que prova visualmente que "saldo é uma projeção, não um número guardado".
    Reversão de transação: gera uma transação nova, espelhada (inverte débitos e créditos), nunca deleta ou edita a original. Isso preserva o princípio de imutabilidade.

    Camada 2 — o simulador de Pix (contexto de produto por cima do motor)

    Chave Pix: um identificador (CPF, email, celular ou aleatório) apontando pra uma conta.
    POST /pix/qrcode — gera um QR code estático (valor fixo ou em aberto) para uma chave.
    POST /pix/pay — simula o pagamento: valida a chave, cria a transação de partida dobrada (débito na conta pagadora, crédito na recebedora, e um crédito residual pra uma conta de taxa se você quiser modelar isso), dispara um "webhook" de liquidação.
    POST /pix/refund — estorno de um pagamento, usando o mecanismo de reversão da camada 1.

    A camada 2 não tem lógica financeira própria — ela só traduz um conceito de produto (pagar com uma chave) em chamadas pro motor de partida dobrada. Isso é deliberado: mostra que você separou domínio contábil de domínio de produto, o que é exatamente como um sistema de pagamentos de verdade é desenhado.

    O que precisa ser garantido sob concorrência

    Essa é a parte que rende a melhor demonstração do projeto. Cenário: duas transferências saindo da mesma conta ao mesmo tempo, ambas dentro do saldo disponível individualmente, mas juntas estourando o saldo.

    Você tem, essencialmente, duas estratégias e vale implementar entendendo o trade-off de cada uma:

    Lock pessimista — SELECT ... FOR UPDATE na conta antes de debitar, dentro da transação. Simples de raciocinar, mas serializa escritas na mesma conta, o que é gargalo se uma conta receber tráfego alto.
    Constraint no banco — uma verificação a nível de banco que impede saldo negativo mesmo se duas transações concorrentes passarem pela checagem em aplicação ao mesmo tempo. Menos intuitivo, mais robusto — a garantia não depende do seu código Node estar correto, depende do banco.

    O teste que prova isso: um script que dispara 1000 transferências concorrentes contra duas ou três contas, com dinheiro suficiente exatamente para que sequencialmente todas passem, mas nem de longe suficiente se alguma race condition permitir overdraft. No final, você soma tudo e prova que o total do sistema não mudou e nenhuma conta ficou negativa.

    Idempotência

    Toda operação que muda dinheiro tem que carregar uma idempotency_key fornecida pelo cliente. Se a mesma chave chegar duas vezes — porque o cliente teve timeout e reenviou, por exemplo — a segunda chamada não pode criar uma segunda transação. Ela deve retornar o resultado da primeira, sem duplicar efeito.

    Isso não é feature nice-to-have, é requisito de qualquer API financeira real — Stripe e Pix de verdade fazem isso.

    Escopo recomendado, em fases

    Fase 1 — núcleo contábil. accounts, transactions, entries. Endpoint de criar transação com validação de balanço. Endpoint de saldo e extrato. Reversão.

    Fase 2 — concorrência e idempotência. Escolha e implemente uma das duas estratégias de lock. Escreva o script de 1000 transferências concorrentes. Implemente idempotency key.

    Fase 3 — Pix por cima. Chaves, QR code, pay, refund — tudo delegando pro motor da fase 1.

    Fase 4 — reconciliação e polimento. Job que recalcula saldo a partir das entries e compara com a projeção cacheada, reportando divergência. Testes. README com o resultado do teste de concorrência documentado.

    Pare na fase 3 se o tempo apertar — a fase 4 é o que separa "bom" de "impressionante", mas as três primeiras já formam um projeto completo e defensável.

    Stack sugerida

    Node + TypeScript, Postgres (é onde FOR UPDATE e transações ACID importam de verdade — não troque por Mongo aqui), um ORM fino ou query builder que não esconda o SQL de você (Knex ou Drizzle são boas escolhas; Prisma funciona mas abstrai demais a parte que você quer aprender). Para o script de concorrência, Promise.all disparando N requisições basta — não precisa de ferramenta de load test pra isso.

    Quer que eu comece te guiando pela modelagem do schema — as tabelas e as constraints que garantem o balanceamento — ou prefere já ir para o endpoint de criação de transação e descobrir na prática por que a validação de balanço precisa estar dentro da mesma transação de banco que a escrita?