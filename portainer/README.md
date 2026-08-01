# Central Portainer — gerência da frota de appliances

Permite ver e operar os containers de todas as lojas a partir de um só painel:
logs, restart, atualização de imagem e implantação de stacks, sem SSH em cada
Radxa.

## Por que Edge Agent, e não Agent comum

| | Agent (porta 9001) | **Edge Agent** |
|---|---|---|
| Quem inicia a conexão | Servidor → loja | **Loja → servidor** |
| Precisa de IP fixo na loja | Sim | Não |
| Precisa abrir porta no roteador | Sim | **Não** |
| Serve para | Técnico na mesma rede/VPN | **Frota em lojas** |

Appliances ficam atrás de NAT com IP dinâmico. O Edge Agent disca para fora,
então nenhuma loja precisa de IP fixo nem porta aberta — que seria, além de
trabalhoso, uma superfície de ataque a mais em cada endereço.

O modo Agent continua útil para um técnico na própria rede da loja.

---

## 1. Subir o servidor

Num host com endereço estável e alcançável pela internet (VPS). **Não no
Radxa** — se o servidor morar dentro de uma loja, a gerência da frota inteira
cai junto com aquela loja.

```bash
git clone https://github.com/raraujoR87/EdgeVisionCam.git
cd EdgeVisionCam

PORTAINER_DOMAIN=portainer.seudominio.com.br \
ACME_EMAIL=voce@empresa.com \
docker compose -f portainer/docker-compose.yml up -d
```

Antes disso, aponte o DNS de `PORTAINER_DOMAIN` para o IP do host e libere:

| Porta | Para quê |
|---|---|
| 80 | Validação do certificado Let's Encrypt |
| 443 | Painel web |
| 8000 | Túnel dos Edge Agents |

A 8000 fica exposta direto porque o túnel é TCP bruto, não HTTP — não passa por
proxy reverso.

### Primeiro acesso

Abra `https://PORTAINER_DOMAIN` e **crie o usuário administrador imediatamente**.
O Portainer bloqueia a criação inicial após alguns minutos de container no ar
sem configuração; se isso acontecer, basta `docker restart portainer-server`.

---

## 2. Registrar uma loja

**No Portainer:** Environments → Add environment → **Edge Agent** → Standard.

- **Name**: identifique a loja (ex.: `loja-centro`)
- **Portainer server URL**: `https://PORTAINER_DOMAIN`

Copie a **Edge key** gerada — é o que autentica aquele appliance.

**No Radxa:**

```bash
sudo bash install.sh \
  --mgmt-mode portainer-edge-agent \
  --edge-key '<EDGE KEY COPIADA>' \
  --edge-id 'loja-centro'
```

O appliance aparece como *up* no painel em cerca de um minuto.

> A Edge key é uma credencial de acesso ao Docker daquela loja. Trate como
> senha: não commite, não mande por canal aberto.

---

## 3. Ligar ao dashboard da nuvem

O console central mostra um botão *Portainer Edge* por loja, lido de
`stores.portainer_endpoint`. O ID do ambiente aparece na URL do Portainer ao
abrir a loja:

```sql
UPDATE stores
SET portainer_endpoint = 'https://portainer.seudominio.com.br/#!/3/docker/dashboard'
WHERE name = 'Loja Piloto';
```

---

## Segurança

**O certificado válido não é enfeite.** O Edge Agent tem acesso ao socket
Docker da loja, e o Portainer consegue implantar stacks por esse canal. Sem
verificação de certificado, um atacante interposto entre a loja e o servidor
implanta containers arbitrários no appliance — com câmera e gravações dentro.

Por isso o `install.sh` só desliga a verificação com `--edge-insecure-poll`
explícito, e o stack acima usa Let's Encrypt via Caddy justamente para que essa
flag nunca seja necessária. Use-a apenas em laboratório, com servidor
autoassinado.

Além disso:

- Senha forte no admin do Portainer, e MFA se disponível.
- Não exponha a porta 9000 (HTTP puro) do container: o stack a mantém interna,
  acessível apenas pelo Caddy.
- Uma Edge key por loja. Reutilizar a mesma chave impede revogar o acesso de
  uma loja sem derrubar as outras.

---

## Diagnóstico

| Sintoma | Causa provável |
|---|---|
| Ambiente fica *down* | Porta 8000 fechada no firewall do servidor |
| `certificate signed by unknown authority` no agente | Certificado ainda não emitido — confira DNS e porta 80 |
| Agente sobe e cai | Edge key de outro ambiente, ou reutilizada |
| Não consegue criar admin | Timeout de segurança: `docker restart portainer-server` |

```bash
# no Radxa
docker logs visioncam-portainer-edge-agent --tail 50

# no servidor
docker logs portainer-server --tail 50
docker logs portainer-caddy --tail 50   # emissão do certificado
```
