"""
Medição de acurácia do VisionCam.

Existe para responder a pergunta comercial do produto: com que frequência ele
erra, e para que lado. Num sistema de prevenção de perdas os dois erros não têm
o mesmo peso — deixar passar um furto custa o valor do item, enquanto acusar um
cliente inocente custa o cliente, a reputação da loja e, eventualmente, um
processo. Por isso o relatório separa precisão de revocação em vez de reportar
uma acurácia única, que esconderia exatamente essa assimetria.
"""
