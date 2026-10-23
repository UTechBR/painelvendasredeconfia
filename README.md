[README.md](https://github.com/user-attachments/files/33893883/README.md)
# Painel de Leads — Rede Confia (lojas Help)

Painel web para importar bases de leads (Saque complementar, CNC e CLT), distribuir entre as lojas e os consultores, registrar vendas (com 3 indicações obrigatórias) e acompanhar a conversão.

**Perfis:** Administrador → Diretor → Supervisor (1 por loja) → Consultor.

## Arquivos

| Arquivo | Para quê | Sobe no GitHub? |
|---|---|---|
| `index.html`, `app.js`, `logic.js`, `xlsx.js`, `logo.png` | O painel | Sim |
| `firebase-config.js` | Dados do seu projeto Firebase (você edita) | Sim (não é segredo) |
| `firestore.rules` | Regras de segurança do banco | Não. Você cola no Firebase |
| `tests/`, `DECISIONS.md`, `README.md` | Testes e documentação | Opcional |

> Nunca suba planilhas com dados reais (clientes ou funcionários) para o GitHub. O painel é público na internet; os dados entram só pelo painel, depois do login.

## Colocar no ar (passo a passo)

1. **Criar o projeto.** Acesse console.firebase.google.com → *Adicionar projeto* → nome `painel-help` → desligue o Google Analytics → *Criar*.
2. **Ligar o login.** *Build → Authentication → Vamos começar → E-mail/senha → Ativar → Salvar*.
3. **Criar o banco.** *Build → Firestore Database → Criar banco de dados* → local **southamerica-east1 (São Paulo)** → **modo de produção** → *Criar*.
4. **Pegar a configuração.** Engrenagem ao lado de *Visão geral do projeto → Configurações do projeto → Seus apps → ícone `</>`* → apelido `painel` → *Registrar app*. Copie `apiKey`, `authDomain`, `projectId` e `appId` para o arquivo `firebase-config.js`, no lugar de `COLE_AQUI`.
5. **Publicar as regras.** *Firestore Database → Regras* → apague tudo → cole o conteúdo de `firestore.rules` → *Publicar*. **Sem isso o painel não funciona e os dados ficam desprotegidos.**
6. **Publicar o site.** Crie um repositório no GitHub, envie os arquivos da tabela acima (coluna "Sim") → *Settings → Pages → Branch: main → Save*. O endereço aparece na mesma tela.
7. **Primeiro acesso (faça logo depois do passo 6).** Abra o endereço: aparece *Primeiro acesso*. Crie o administrador (você). Essa tela só aparece uma vez; depois dela, ninguém mais consegue criar administrador.
8. **Montar a estrutura.** No painel: *Equipe → Carregar estrutura (planilha)* → escolha a planilha de funcionários (colunas Nomes, Loja, Cargo). Baixe a lista de senhas provisórias e entregue uma a uma. Depois *Novo usuário* → o diretor → cargo **Diretor**.
9. **Rotina.** *Importar* (você) → *Distribuir* (o diretor envia às lojas) → *Distribuir* (cada supervisor passa aos consultores) → consultores trabalham os leads → *Relatório*.

## Como funciona no dia a dia

- **Importar:** escolha o produto, diga de onde vieram os leads e envie `.xlsx` ou `.csv` com as colunas NOME e CPF (telefone opcional; as outras colunas ficam na ficha). CPF inválido ou repetido é ignorado e listado. Reimportar o mesmo arquivo não duplica.
- **Distribuir:** tabela com os destinos nas linhas e os produtos nas colunas. *Dividir tudo igualmente* preenche tudo; ajuste os números se quiser e clique em *Enviar*.
- **Venda fechada:** o consultor precisa informar 3 indicações (nome e CPF). Elas viram leads novos para ele, com origem "Indicação de …".
- **Senha esquecida:** o diretor redefine a do supervisor, o supervisor a do consultor, o administrador a de qualquer um (*Equipe → Redefinir senha*). A pessoa troca a senha provisória no primeiro acesso.

## Conferir a segurança depois de publicar (5 minutos)

1. Entre como consultor: só aparecem os leads dele e nenhuma aba além de *Leads*.
2. Entre como supervisor de uma loja: não aparecem leads nem pessoas de outras lojas.
3. Entre como diretor: ele não vê a aba *Importar* e não consegue editar um lead.
4. Tente abrir o endereço em outro navegador sem login: só a tela de entrada aparece.
5. Em *Firestore → Regras → Playground*, simule leitura de `leads/qualquer` sem estar logado: deve ser **negado**.

## Limites do plano gratuito do Firebase (Spark)

Cota por dia: **50 mil leituras** e **20 mil gravações**. Cada vez que o administrador ou o diretor abrem o painel, são lidos todos os leads (1 leitura por lead). Importar N leads gasta N gravações; distribuir N leads gasta outras N.

- Até uns 5 mil leads em uso, o gratuito costuma bastar.
- Passou disso: troque para o plano **Blaze** (paga só o que usar, centavos nesse volume) e crie um alerta de orçamento em *Uso e faturamento*.
- Lotes grandes: importe em dias diferentes se passar de ~15 mil leads por dia.

## Para quem for mexer no código

```
npm test                      # regras de negócio (logic.js)
python3 -m http.server 8765   # em outro terminal
python3 tests/e2e.py          # fluxo completo no navegador com Firebase simulado (tests/mock)
```

O Firebase simulado reproduz as regras principais, mas **não substitui** testar o `firestore.rules` real (use o checklist acima). Só use dados fictícios nos testes.
