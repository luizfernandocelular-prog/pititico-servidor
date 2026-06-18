const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

function obterSenhaAdmin(req) {
  return String(req.headers["x-admin-password"] || req.query.adminSenha || req.body?.adminSenha || "").trim();
}

function adminProtegido(req, res, next) {
  if (obterSenhaAdmin(req) === ADMIN_PASSWORD) return next();
  return res.status(401).json({ sucesso:false, mensagem:"Acesso admin não autorizado." });
}

app.use(express.static("public"));

const PORTA = process.env.PORT || 3000;
const DIAS_ATIVO = 5;
const ARQUIVO = path.join(__dirname, "banco.json");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "pititico";

if (!MONGO_URI) {
  console.error("ERRO: MONGO_URI não configurada no arquivo .env");
  process.exit(1);
}

const client = new MongoClient(MONGO_URI);

let db;
let usuariosCollection;
let publicacoesCollection;

function agoraISO() {
  return new Date().toISOString();
}

function calcularExpiracao() {
  const data = new Date();
  data.setDate(data.getDate() + DIAS_ATIVO);
  return data.toISOString();
}


const DIAS_GRATIS_APP = Number(process.env.DIAS_GRATIS_APP || 90);

function adicionarDiasISO(dataBase, dias) {
  const data = new Date(dataBase || agoraISO());
  data.setDate(data.getDate() + dias);
  return data.toISOString();
}

function normalizarUsuarioPlano(usuario) {
  if (!usuario) return null;

  const inicio = usuario.trialInicio || usuario.criadoEm || agoraISO();
  const expira = usuario.trialExpiraEm || adicionarDiasISO(inicio, DIAS_GRATIS_APP);

  const agora = new Date();
  const fim = new Date(expira);
  const diasRestantes = Math.ceil((fim - agora) / (1000 * 60 * 60 * 24));

  const assinaturaAtiva =
    usuario.plano === "premium" ||
    usuario.premiumAtivo === true ||
    usuario.assinaturaStatus === "ativo";

  return {
    ...usuario,
    plano: usuario.plano || "gratis",
    trialInicio: inicio,
    trialExpiraEm: expira,
    trialDiasRestantes: Math.max(0, diasRestantes),
    trialExpirado: !assinaturaAtiva && diasRestantes <= 0,
    premiumAtivo: assinaturaAtiva
  };
}

function acessoUsuarioBloqueado(usuario) {
  if (!usuario) return { bloqueado: true, motivo: "Usuário não encontrado." };

  const normalizado = normalizarUsuarioPlano(usuario);

  if (normalizado.status === "banido") {
    return { bloqueado: true, motivo: "Este usuário foi banido e não pode acessar o aplicativo." };
  }

  if (normalizado.trialExpirado) {
    return {
      bloqueado: true,
      motivo: "Seu acesso gratuito de 90 dias expirou. Em breve será possível ativar o plano Premium.",
      usuario: normalizado
    };
  }

  return { bloqueado: false, usuario: normalizado };
}


function mesAtual() {
  return new Date().toISOString().slice(0, 7);
}

function diasEntre(dataISO) {
  if (!dataISO) return 9999;
  const data = new Date(dataISO);
  if (isNaN(data.getTime())) return 9999;
  return Math.floor((Date.now() - data.getTime()) / (1000 * 60 * 60 * 24));
}

function parceiroSeguro(p) {
  if (!p) return null;
  const { senha, ...limpo } = p;
  return limpo;
}

async function obterParceiroPorCredenciais(req) {
  const email = String(req.headers["x-parceiro-email"] || req.body?.email || req.query.email || "").trim().toLowerCase();
  const senha = String(req.headers["x-parceiro-senha"] || req.body?.senha || req.query.senha || "").trim();

  if (!email || !senha) return null;

  return await db.collection("parceiros").findOne({
    emailLower: email,
    senha,
    status: { $ne: "bloqueado" }
  });
}

async function parceiroProtegido(req, res, next) {
  try {
    const parceiro = await obterParceiroPorCredenciais(req);
    if (!parceiro) {
      return res.status(401).json({ sucesso:false, mensagem:"Acesso do parceiro não autorizado." });
    }
    req.parceiro = parceiro;
    next();
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao validar parceiro.", detalhe:erro.message });
  }
}

function filtroIdAnuncio(id) {
  return isNaN(Number(id)) ? { _id: new ObjectId(id) } : { id:Number(id) };
}

function estaExpirado(item) {
  if (!item.expiraEm) return false;
  return new Date(item.expiraEm) < new Date();
}

function itemPertenceAoUsuario(item, usuario) {
  if (!item || !usuario) return false;

  const emailItem = String(item.usuario?.email || item.emailUsuario || "").toLowerCase();
  const emailUsuario = String(usuario.email || "").toLowerCase();

  return (
    item.donoDeviceId === usuario.deviceId ||
    item.deviceId === usuario.deviceId ||
    (emailItem && emailUsuario && emailItem === emailUsuario)
  );
}

async function conectarMongo() {
  await client.connect();
  db = client.db(DB_NAME);
  usuariosCollection = db.collection("usuarios");
  publicacoesCollection = db.collection("publicacoes");

  await usuariosCollection.createIndex({ emailLower: 1 }, { unique: true, sparse: true });
  await usuariosCollection.createIndex({ deviceId: 1 });
  await publicacoesCollection.createIndex({ id: 1 }, { unique: true });
  await publicacoesCollection.createIndex({ status: 1 });
  await publicacoesCollection.createIndex({ donoDeviceId: 1 });
  await db.collection("parceiros").createIndex({ emailLower: 1 }, { unique: true, sparse: true });
  await db.collection("anuncios").createIndex({ parceiroId: 1 });
  await db.collection("anuncios").createIndex({ parceiroEmail: 1 });

  console.log("MongoDB conectado:", DB_NAME);
}

function bancoPadrao() {
  return { usuarios: [], publicacoes: [] };
}

function lerBancoJsonLocal() {
  if (!fs.existsSync(ARQUIVO)) return bancoPadrao();

  const conteudo = fs.readFileSync(ARQUIVO, "utf8");

  if (!conteudo.trim()) return bancoPadrao();

  const banco = JSON.parse(conteudo);

  if (!Array.isArray(banco.usuarios)) banco.usuarios = [];
  if (!Array.isArray(banco.publicacoes)) banco.publicacoes = [];

  return banco;
}

async function migrarBancoJsonSeVazio() {
  const usuariosMongo = await usuariosCollection.countDocuments();
  const publicacoesMongo = await publicacoesCollection.countDocuments();

  if (usuariosMongo > 0 || publicacoesMongo > 0) {
    console.log("MongoDB já possui dados. Migração automática ignorada.");
    return;
  }

  if (!fs.existsSync(ARQUIVO)) {
    console.log("banco.json não encontrado. Migração ignorada.");
    return;
  }

  try {
    const banco = lerBancoJsonLocal();

    if (banco.usuarios.length) {
      const usuarios = banco.usuarios.map(u => ({
        ...u,
        emailLower: String(u.email || "").toLowerCase(),
        status: u.status || "ativo"
      }));

      await usuariosCollection.insertMany(usuarios, { ordered: false }).catch(() => {});
    }

    if (banco.publicacoes.length) {
      await publicacoesCollection.insertMany(banco.publicacoes, { ordered: false }).catch(() => {});
    }

    console.log("Migração do banco.json concluída.");
  } catch (erro) {
    console.warn("Migração automática falhou:", erro.message);
  }
}

async function limparExpirados() {
  await publicacoesCollection.updateMany(
    {
      status: "ativo",
      expiraEm: { $lt: agoraISO() }
    },
    {
      $set: {
        status: "expirado",
        expiradoEm: agoraISO()
      }
    }
  );
}

app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.send("Servidor PiTiTiCo funcionando com MongoDB!");
});

app.get("/status", async (req, res) => {
  const usuarios = await usuariosCollection.countDocuments();
  const publicacoes = await publicacoesCollection.countDocuments();

  res.json({
    online: true,
    servidor: "PiTiTiCo",
    banco: "MongoDB Atlas",
    usuarios,
    publicacoes,
    data: agoraISO()
  });
});

app.post("/usuarios", async (req, res) => {
  try {
    const { nome, email, whatsapp, deviceId, senha } = req.body;

    if (!nome || !email || !whatsapp || !deviceId) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Nome, e-mail, WhatsApp e deviceId são obrigatórios."
      });
    }

    const senhaFinal = String(senha || "0000");
    const emailLower = String(email).toLowerCase();

    let usuario =
      await usuariosCollection.findOne({ emailLower }) ||
      await usuariosCollection.findOne({ deviceId });

    if (usuario) {
      const checagem = acessoUsuarioBloqueado(usuario);

      if (checagem.bloqueado) {
        return res.status(403).json({
          sucesso: false,
          mensagem: checagem.motivo,
          usuario: checagem.usuario
        });
      }

      await usuariosCollection.updateOne(
        { _id: usuario._id },
        {
          $set: {
            nome,
            email,
            emailLower,
            whatsapp,
            deviceId,
            senha: senhaFinal,
            status: usuario.status || "ativo",
            plano: usuario.plano || "gratis",
            trialInicio: usuario.trialInicio || usuario.criadoEm || agoraISO(),
            trialExpiraEm: usuario.trialExpiraEm || adicionarDiasISO(usuario.criadoEm || agoraISO(), DIAS_GRATIS_APP),
            atualizadoEm: agoraISO()
          }
        }
      );

      usuario = await usuariosCollection.findOne({ _id: usuario._id });
    } else {
      const criadoEm = agoraISO();

      usuario = {
        id: Date.now(),
        deviceId,
        nome,
        email,
        emailLower,
        whatsapp,
        senha: senhaFinal,
        status: "ativo",
        plano: "gratis",
        trialInicio: criadoEm,
        trialExpiraEm: adicionarDiasISO(criadoEm, DIAS_GRATIS_APP),
        premiumAtivo: false,
        criadoEm,
        atualizadoEm: criadoEm
      };

      await usuariosCollection.insertOne(usuario);
    }

    const usuarioFinal = normalizarUsuarioPlano(usuario);

    res.json({
      sucesso: true,
      mensagem: "Usuária salva com sucesso.",
      usuario: usuarioFinal
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao salvar usuária.",
      detalhe: erro.message
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const emailLower = String(req.body.email || "").toLowerCase();
    const senha = String(req.body.senha || "");

    const usuario = await usuariosCollection.findOne({
      emailLower,
      senha
    });

    if (!usuario) {
      return res.status(401).json({
        sucesso: false,
        mensagem: "E-mail ou senha inválidos."
      });
    }

    const checagem = acessoUsuarioBloqueado(usuario);

    if (checagem.bloqueado) {
      return res.status(403).json({
        sucesso: false,
        mensagem: checagem.motivo,
        usuario: checagem.usuario
      });
    }

    const usuarioFinal = checagem.usuario;

    await usuariosCollection.updateOne(
      { _id: usuario._id },
      {
        $set: {
          ultimoLoginEm: agoraISO(),
          trialInicio: usuarioFinal.trialInicio,
          trialExpiraEm: usuarioFinal.trialExpiraEm,
          plano: usuarioFinal.plano || "gratis"
        }
      }
    );

    res.json({ sucesso: true, usuario: usuarioFinal });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao fazer login.",
      detalhe: erro.message
    });
  }
});

app.get("/usuarios", async (req, res) => {
  try {
    const usuarios = await usuariosCollection.find({}).toArray();
    res.json(usuarios);
  } catch (erro) {
    res.status(500).json({
      erro: "Erro ao listar usuárias",
      detalhe: erro.message
    });
  }
});

app.get("/admin/usuarios", adminProtegido, async (req, res) => {
  try {
    await limparExpirados();

    const usuarios = await usuariosCollection.find({}).toArray();
    const publicacoes = await publicacoesCollection.find({}).toArray();

    const resposta = usuarios.map(usuario => {
      const itens = publicacoes.filter(item => itemPertenceAoUsuario(item, usuario));

      return {
        ...normalizarUsuarioPlano(usuario),
        totalItens: itens.length,
        itensAtivos: itens.filter(i => i.status === "ativo").length,
        itensRemovidos: itens.filter(i => i.status === "removido").length,
        itensExpirados: itens.filter(i => i.status === "expirado").length
      };
    });

    res.json(resposta);
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao listar usuários.",
      detalhe: erro.message
    });
  }
});


app.put("/admin/usuarios/:id", adminProtegido, async (req, res) => {
  try {
    const idParam = String(req.params.id || "");
    const status = req.body.status || "ativo";
    const filtros = [];
    if (!isNaN(Number(idParam))) filtros.push({ id: Number(idParam) });
    if (ObjectId.isValid(idParam)) filtros.push({ _id: new ObjectId(idParam) });
    if (idParam.includes("@")) filtros.push({ emailLower: idParam.toLowerCase() }, { email: idParam.toLowerCase() });

    const filtro = filtros.length ? { $or: filtros } : { id: -1 };
    const dados = status === "banido"
      ? { status: "banido", banidoEm: agoraISO() }
      : { status: "ativo", reativadoEm: agoraISO() };

    const r = await usuariosCollection.updateOne(filtro, { $set: dados });
    if (!r.matchedCount) return res.status(404).json({ sucesso:false, mensagem:"Usuário não encontrado." });
    res.json({ sucesso:true, mensagem: status === "banido" ? "Usuário banido." : "Usuário reativado." });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao alterar usuário.", detalhe:erro.message });
  }
});

app.delete("/admin/usuarios/:id", adminProtegido, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const usuario = await usuariosCollection.findOne({ id });

    if (!usuario) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Usuário não encontrado."
      });
    }

    await usuariosCollection.updateOne(
      { id },
      {
        $set: {
          status: "banido",
          banidoEm: agoraISO()
        }
      }
    );

    const emailUsuario = String(usuario.email || "").toLowerCase();

    await publicacoesCollection.updateMany(
      {
        status: "ativo",
        $or: [
          { donoDeviceId: usuario.deviceId },
          { deviceId: usuario.deviceId },
          { "usuario.email": usuario.email },
          { emailUsuario: usuario.email },
          { "usuario.email": emailUsuario },
          { emailUsuario }
        ]
      },
      {
        $set: {
          status: "removido",
          removidoEm: agoraISO(),
          motivoRemocao: "Usuário removido/banido pelo admin"
        }
      }
    );

    res.json({
      sucesso: true,
      mensagem: "Usuário banido e itens ativos removidos da vitrine."
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao remover/banir usuário.",
      detalhe: erro.message
    });
  }
});

app.post("/admin/usuarios/:id/reativar", adminProtegido, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const usuario = await usuariosCollection.findOne({ id });

    if (!usuario) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Usuário não encontrado."
      });
    }

    await usuariosCollection.updateOne(
      { id },
      {
        $set: {
          status: "ativo",
          reativadoEm: agoraISO()
        }
      }
    );

    res.json({
      sucesso: true,
      mensagem: "Usuário reativado com sucesso."
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao reativar usuário.",
      detalhe: erro.message
    });
  }
});

app.post("/publicacoes", async (req, res) => {
  try {
    const { item, deviceId } = req.body;

    if (!item) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "O nome do item é obrigatório."
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Cadastro da usuária não identificado."
      });
    }

    await limparExpirados();

    const emailUsuarioReq = String(req.body.emailUsuario || "").toLowerCase();

    const usuario =
      await usuariosCollection.findOne({ deviceId }) ||
      await usuariosCollection.findOne({ emailLower: emailUsuarioReq });

    const novaPublicacao = {
      ...req.body,
      id: Date.now(),
      status: "ativo",
      criadoEm: agoraISO(),
      expiraEm: calcularExpiracao(),
      diasAtivo: DIAS_ATIVO,
      donoDeviceId: deviceId,
      usuario: usuario
        ? {
            nome: usuario.nome,
            email: usuario.email,
            whatsapp: usuario.whatsapp
          }
        : {
            nome: req.body.nomeUsuario || "Usuária PiTiTiCo",
            email: req.body.emailUsuario || "",
            whatsapp: req.body.whatsappUsuario || req.body.whats || ""
          }
    };

    await publicacoesCollection.insertOne(novaPublicacao);

    res.json({
      sucesso: true,
      mensagem: "Item publicado na vitrine PiTiTiCo.",
      publicacao: novaPublicacao
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao salvar publicação.",
      detalhe: erro.message
    });
  }
});

app.get("/publicacoes", async (req, res) => {
  try {
    await limparExpirados();

    const deviceId = req.query.deviceId;
    const email = String(req.query.email || "").toLowerCase();

    const ativos = await publicacoesCollection.find({ status: "ativo" }).toArray();

    const resposta = ativos.filter(item => {
      if (deviceId && (item.donoDeviceId === deviceId || item.deviceId === deviceId)) {
        return false;
      }

      const emailDono = String(item.usuario?.email || item.emailUsuario || "").toLowerCase();

      if (email && emailDono === email) {
        return false;
      }

      return true;
    });

    res.json(resposta);
  } catch (erro) {
    res.status(500).json({
      erro: "Erro ao listar publicações",
      detalhe: erro.message
    });
  }
});

app.get("/minhas-publicacoes", async (req, res) => {
  try {
    await limparExpirados();

    const deviceId = req.query.deviceId;
    const email = String(req.query.email || "").toLowerCase();

    if (!deviceId && !email) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "deviceId ou email obrigatório."
      });
    }

    const todas = await publicacoesCollection.find({ status: "ativo" }).toArray();

    const minhas = todas.filter(item => {
      const emailDono = String(item.usuario?.email || item.emailUsuario || "").toLowerCase();

      if (email && emailDono && emailDono === email) return true;
      if (deviceId && item.donoDeviceId === deviceId) return true;
      if (deviceId && item.deviceId === deviceId) return true;

      return false;
    });

    res.json(minhas);
  } catch (erro) {
    res.status(500).json({
      erro: "Erro ao listar seus itens",
      detalhe: erro.message
    });
  }
});


app.post("/admin/usuarios/plano", adminProtegido, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const plano = String(req.body.plano || "gratis").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ sucesso:false, mensagem:"Informe o e-mail do usuário." });
    }

    const premium = plano === "premium";

    const dados = premium
      ? { plano:"premium", premiumAtivo:true, assinaturaStatus:"ativo", premiumAtivadoEm:agoraISO(), atualizadoEm:agoraISO() }
      : { plano:"gratis", premiumAtivo:false, assinaturaStatus:"inativo", atualizadoEm:agoraISO() };

    const r = await usuariosCollection.updateOne(
      { $or:[{ emailLower: email }, { email }] },
      { $set: dados }
    );

    if (!r.matchedCount) {
      return res.status(404).json({ sucesso:false, mensagem:"Usuário não encontrado." });
    }

    res.json({ sucesso:true, mensagem: premium ? "Plano Premium ativado." : "Plano gratuito ativado." });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao alterar plano.", detalhe:erro.message });
  }
});

app.get("/admin/publicacoes", adminProtegido, async (req, res) => {
  try {
    await limparExpirados();

    const publicacoes = await publicacoesCollection.find({}).toArray();
    res.json(publicacoes);
  } catch (erro) {
    res.status(500).json({
      erro: "Erro ao listar publicações",
      detalhe: erro.message
    });
  }
});

app.delete("/publicacoes/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const deviceId = req.body.deviceId || req.query.deviceId;
    const email = String(req.body.email || req.query.email || "").toLowerCase();

    const item = await publicacoesCollection.findOne({ id });

    if (!item) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Item não encontrado."
      });
    }

    const emailDono = String(item.usuario?.email || item.emailUsuario || "").toLowerCase();

    const ehDono =
      item.donoDeviceId === deviceId ||
      item.deviceId === deviceId ||
      (email && emailDono === email);

    if (!ehDono) {
      return res.status(403).json({
        sucesso: false,
        mensagem: "Você só pode remover itens cadastrados por você."
      });
    }

    await publicacoesCollection.updateOne(
      { id },
      {
        $set: {
          status: "removido",
          removidoEm: agoraISO()
        }
      }
    );

    res.json({
      sucesso: true,
      mensagem: "Item removido da vitrine."
    });
  } catch (erro) {
    res.status(500).json({
      sucesso: false,
      mensagem: "Erro ao remover item.",
      detalhe: erro.message
    });
  }
});


// Dados pessoais por usuário: bebês, rotina, atividades, apoio, alimentação e agenda
app.post("/dados-pessoais/:tipo", async (req, res) => {
  try {
    const tipo = req.params.tipo;
    const permitidos = ["bebes", "rotinas", "atividades", "apoios", "alimentacoes", "agenda"];

    if (!permitidos.includes(tipo)) {
      return res.status(400).json({ sucesso: false, mensagem: "Tipo de dado inválido." });
    }

    const emailUsuario = String(req.body.emailUsuario || req.body.email || "").toLowerCase();
    const deviceId = req.body.deviceId || "";

    if (!emailUsuario && !deviceId) {
      return res.status(400).json({ sucesso: false, mensagem: "Usuário não identificado." });
    }

    const dadosCollection = db.collection("dados_pessoais");

    const registro = {
      ...req.body,
      id: req.body.id || Date.now(),
      tipo,
      emailUsuario,
      deviceId,
      criadoEm: req.body.criadoEm || agoraISO(),
      atualizadoEm: agoraISO(),
      status: req.body.status || "ativo"
    };

    await dadosCollection.insertOne(registro);
    res.json({ sucesso: true, registro });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar dado pessoal.", detalhe: erro.message });
  }
});

app.get("/dados-pessoais/:tipo", async (req, res) => {
  try {
    const tipo = req.params.tipo;
    const permitidos = ["bebes", "rotinas", "atividades", "apoios", "alimentacoes", "agenda"];

    if (!permitidos.includes(tipo)) {
      return res.status(400).json({ sucesso: false, mensagem: "Tipo de dado inválido." });
    }

    const emailUsuario = String(req.query.email || "").toLowerCase();
    const deviceId = req.query.deviceId || "";

    if (!emailUsuario && !deviceId) return res.json([]);

    const dadosCollection = db.collection("dados_pessoais");
    const dados = await dadosCollection.find({
      tipo,
      status: "ativo",
      $or: [{ emailUsuario }, { deviceId }]
    }).toArray();

    res.json(dados);
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: "Erro ao listar dados pessoais.", detalhe: erro.message });
  }
});

app.delete("/dados-pessoais/:tipo/:id", async (req, res) => {
  try {
    const tipo = req.params.tipo;
    const id = Number(req.params.id);
    const emailUsuario = String(req.body.email || req.query.email || "").toLowerCase();
    const deviceId = req.body.deviceId || req.query.deviceId || "";

    const dadosCollection = db.collection("dados_pessoais");
    const resultado = await dadosCollection.updateOne(
      {
        tipo,
        id,
        status: "ativo",
        $or: [{ emailUsuario }, { deviceId }]
      },
      { $set: { status: "removido", removidoEm: agoraISO() } }
    );

    if (!resultado.matchedCount) {
      return res.status(404).json({ sucesso: false, mensagem: "Registro não encontrado." });
    }

    res.json({ sucesso: true, mensagem: "Registro removido." });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: "Erro ao remover dado pessoal.", detalhe: erro.message });
  }
});



// ETAPA 2 - ROTAS ADMIN, USUÁRIOS, ITENS E ANÚNCIOS
app.get("/admin/anuncios", adminProtegido, async (req, res) => {
  try {
    const anuncios = await db.collection("anuncios").find({}).sort({ criadoEm: -1 }).toArray();
    res.json(anuncios);
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao listar anúncios.", detalhe:erro.message });
  }
});


// =======================
// PARCEIROS / ANUNCIANTES
// =======================

app.get("/admin/parceiros", adminProtegido, async (req, res) => {
  try {
    const parceiros = await db.collection("parceiros").find({}).sort({ criadoEm:-1 }).toArray();
    const anuncios = await db.collection("anuncios").find({}).toArray();

    const resultado = parceiros.map(p => {
      const pid = String(p._id);
      const ads = anuncios.filter(a =>
        String(a.parceiroId || "") === pid ||
        String(a.parceiroEmail || "").toLowerCase() === String(p.email || "").toLowerCase()
      );

      const ativos = ads.filter(a => String(a.status || "ativo").toLowerCase() === "ativo").length;

      return {
        ...parceiroSeguro(p),
        anunciosTotal: ads.length,
        anunciosAtivos: ativos,
        anuncios: ads.map(a => ({
          _id: a._id,
          id: a.id,
          titulo: a.titulo,
          status: a.status || "ativo",
          criadoEm: a.criadoEm,
          atualizadoEm: a.atualizadoEm,
          imagem: a.imagem,
          link: a.link
        }))
      };
    });

    res.json(resultado);
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao listar parceiros.", detalhe:erro.message });
  }
});

app.post("/admin/parceiros", adminProtegido, async (req, res) => {
  try {
    const nome = String(req.body.nome || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const senha = String(req.body.senha || "").trim();
    const whatsapp = String(req.body.whatsapp || "").trim();

    if (!nome || !email || !senha) {
      return res.status(400).json({ sucesso:false, mensagem:"Nome, e-mail e senha são obrigatórios." });
    }

    const parceiro = {
      id: Date.now(),
      nome,
      email,
      emailLower: email,
      senha,
      whatsapp,
      status: req.body.status || "ativo",
      plano: req.body.plano || "basico",
      limiteAnunciosMes: Number(req.body.limiteAnunciosMes || 3),
      limiteTrocasImagemMes: Number(req.body.limiteTrocasImagemMes || 1),
      criadoEm: agoraISO(),
      atualizadoEm: agoraISO()
    };

    await db.collection("parceiros").insertOne(parceiro);
    res.json({ sucesso:true, parceiro: parceiroSeguro(parceiro) });
  } catch (erro) {
    if (String(erro.message).includes("duplicate")) {
      return res.status(409).json({ sucesso:false, mensagem:"Parceiro já cadastrado com este e-mail." });
    }
    res.status(500).json({ sucesso:false, mensagem:"Erro ao cadastrar parceiro.", detalhe:erro.message });
  }
});

app.put("/admin/parceiros/:id", adminProtegido, async (req, res) => {
  try {
    const id = req.params.id;
    const filtro = isNaN(Number(id)) ? { _id: new ObjectId(id) } : { id:Number(id) };
    const dados = {
      ...req.body,
      atualizadoEm: agoraISO()
    };
    delete dados._id;
    if (dados.email) {
      dados.email = String(dados.email).trim().toLowerCase();
      dados.emailLower = dados.email;
    }
    if (dados.limiteAnunciosMes !== undefined) dados.limiteAnunciosMes = Number(dados.limiteAnunciosMes);
    if (dados.limiteTrocasImagemMes !== undefined) dados.limiteTrocasImagemMes = Number(dados.limiteTrocasImagemMes);

    const r = await db.collection("parceiros").updateOne(filtro, { $set:dados });
    if (!r.matchedCount) return res.status(404).json({ sucesso:false, mensagem:"Parceiro não encontrado." });
    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao atualizar parceiro.", detalhe:erro.message });
  }
});

app.post("/parceiros/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const senha = String(req.body.senha || "").trim();

    const parceiro = await db.collection("parceiros").findOne({
      emailLower: email,
      senha,
      status: { $ne:"bloqueado" }
    });

    if (!parceiro) {
      return res.status(401).json({ sucesso:false, mensagem:"E-mail ou senha inválidos, ou parceiro bloqueado." });
    }

    res.json({ sucesso:true, parceiro: parceiroSeguro(parceiro) });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao fazer login do parceiro.", detalhe:erro.message });
  }
});

app.get("/parceiros/me", parceiroProtegido, async (req, res) => {
  try {
    const parceiro = req.parceiro;
    const mes = mesAtual();

    const anunciosMes = await db.collection("anuncios").countDocuments({
      parceiroId: String(parceiro._id),
      mesCriacao: mes
    });

    const anunciosTotal = await db.collection("anuncios").countDocuments({
      parceiroId: String(parceiro._id)
    });

    res.json({
      sucesso:true,
      parceiro: parceiroSeguro(parceiro),
      limites: {
        mes,
        anunciosMes,
        anunciosTotal,
        limiteAnunciosMes: Number(parceiro.limiteAnunciosMes || 3),
        trocasImagemMes: Number(parceiro.trocasImagemMes === mes ? parceiro.trocasImagemUsadasMes || 0 : 0),
        limiteTrocasImagemMes: Number(parceiro.limiteTrocasImagemMes || 1)
      }
    });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao carregar parceiro.", detalhe:erro.message });
  }
});

app.get("/parceiros/anuncios", parceiroProtegido, async (req, res) => {
  try {
    const parceiro = req.parceiro;
    const anuncios = await db.collection("anuncios")
      .find({ parceiroId: String(parceiro._id) })
      .sort({ criadoEm:-1 })
      .toArray();

    res.json(anuncios);
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao listar anúncios do parceiro.", detalhe:erro.message });
  }
});

app.post("/parceiros/anuncios", parceiroProtegido, async (req, res) => {
  try {
    const parceiro = req.parceiro;
    const mes = mesAtual();
    const limite = Number(parceiro.limiteAnunciosMes || 3);

    const criadosMes = await db.collection("anuncios").countDocuments({
      parceiroId: String(parceiro._id),
      mesCriacao: mes
    });

    if (criadosMes >= limite) {
      return res.status(403).json({
        sucesso:false,
        mensagem:`Limite mensal atingido. Este plano permite ${limite} anúncios por mês.`
      });
    }

    const titulo = String(req.body.titulo || "").trim();
    const texto = String(req.body.texto || "").trim();
    const imagem = String(req.body.imagem || "").trim();
    const link = String(req.body.link || "").trim();

    if (!titulo || !texto || !imagem) {
      return res.status(400).json({ sucesso:false, mensagem:"Título, texto e imagem são obrigatórios." });
    }

    const anuncio = {
      id: Date.now(),
      parceiroId: String(parceiro._id),
      parceiroNome: parceiro.nome,
      parceiroEmail: parceiro.email,
      mesCriacao: mes,
      titulo,
      texto,
      imagem,
      link,
      status: "ativo",
      origem: "parceiro",
      trocasImagem: 0,
      criadoEm: agoraISO(),
      atualizadoEm: agoraISO(),
      imagemCriadaEm: agoraISO(),
      ultimaTrocaImagem: agoraISO()
    };

    await db.collection("anuncios").insertOne(anuncio);
    res.json({ sucesso:true, anuncio });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao cadastrar anúncio.", detalhe:erro.message });
  }
});

app.put("/parceiros/anuncios/:id", parceiroProtegido, async (req, res) => {
  try {
    const parceiro = req.parceiro;
    const id = req.params.id;
    const filtro = filtroIdAnuncio(id);

    const anuncio = await db.collection("anuncios").findOne({
      ...filtro,
      parceiroId: String(parceiro._id)
    });

    if (!anuncio) return res.status(404).json({ sucesso:false, mensagem:"Anúncio não encontrado." });

    const dados = {
      titulo: String(req.body.titulo || anuncio.titulo || "").trim(),
      texto: String(req.body.texto || anuncio.texto || "").trim(),
      link: String(req.body.link || anuncio.link || "").trim(),
      status: String(req.body.status || anuncio.status || "ativo").trim(),
      atualizadoEm: agoraISO()
    };

    const novaImagem = String(req.body.imagem || "").trim();
    const imagemMudou = novaImagem && novaImagem !== String(anuncio.imagem || "");

    if (imagemMudou) {
      const idadeDias = diasEntre(anuncio.criadoEm || anuncio.imagemCriadaEm);
      if (idadeDias < 15) {
        return res.status(403).json({
          sucesso:false,
          mensagem:`A imagem só pode ser substituída após 15 dias. Faltam ${15 - idadeDias} dia(s). O texto pode ser editado normalmente.`
        });
      }

      const mes = mesAtual();
      const trocasUsadas = parceiro.trocasImagemMes === mes ? Number(parceiro.trocasImagemUsadasMes || 0) : 0;
      const limiteTrocas = Number(parceiro.limiteTrocasImagemMes || 1);

      if (trocasUsadas >= limiteTrocas) {
        return res.status(403).json({
          sucesso:false,
          mensagem:`Limite de substituição de imagem atingido. Este plano permite ${limiteTrocas} troca por mês.`
        });
      }

      dados.imagem = novaImagem;
      dados.ultimaTrocaImagem = agoraISO();
      dados.trocasImagem = Number(anuncio.trocasImagem || 0) + 1;

      await db.collection("parceiros").updateOne(
        { _id: parceiro._id },
        {
          $set: { trocasImagemMes: mes, atualizadoEm: agoraISO() },
          $inc: { trocasImagemUsadasMes: 1 }
        }
      );
    }

    const r = await db.collection("anuncios").updateOne(
      { _id: anuncio._id },
      { $set: dados }
    );

    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao atualizar anúncio.", detalhe:erro.message });
  }
});

app.get("/anuncios", async (req, res) => {
  try {
    const anuncios = await db.collection("anuncios").find({ status:"ativo" }).sort({ criadoEm: -1 }).toArray();
    res.json(anuncios);
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao listar anúncios.", detalhe:erro.message });
  }
});

app.post("/admin/anuncios", adminProtegido, async (req, res) => {
  try {
    const anuncio = {
      id: Date.now(),
      titulo: req.body.titulo || "",
      texto: req.body.texto || "",
      imagem: req.body.imagem || "",
      link: req.body.link || "",
      status: req.body.status || "ativo",
      origem: req.body.origem || "admin",
      parceiroId: req.body.parceiroId || "",
      parceiroNome: req.body.parceiroNome || "",
      parceiroEmail: req.body.parceiroEmail || "",
      criadoEm: agoraISO(),
      atualizadoEm: agoraISO()
    };
    await db.collection("anuncios").insertOne(anuncio);
    res.json({ sucesso:true, anuncio });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao cadastrar anúncio.", detalhe:erro.message });
  }
});

app.put("/admin/anuncios/:id", adminProtegido, async (req, res) => {
  try {
    const id = req.params.id;
    const filtro = isNaN(Number(id)) ? { _id: new ObjectId(id) } : { id:Number(id) };
    const dados = { ...req.body, atualizadoEm: agoraISO() };
    delete dados._id;
    const r = await db.collection("anuncios").updateOne(filtro, { $set:dados });
    if (!r.matchedCount) return res.status(404).json({ sucesso:false, mensagem:"Anúncio não encontrado." });
    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao atualizar anúncio.", detalhe:erro.message });
  }
});

app.delete("/admin/anuncios/:id", adminProtegido, async (req, res) => {
  try {
    const id = req.params.id;
    const filtro = isNaN(Number(id)) ? { _id: new ObjectId(id) } : { id:Number(id) };
    const r = await db.collection("anuncios").deleteOne(filtro);
    if (!r.deletedCount) return res.status(404).json({ sucesso:false, mensagem:"Anúncio não encontrado." });
    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao excluir anúncio.", detalhe:erro.message });
  }
});

app.post("/admin/usuarios/banir", adminProtegido, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ sucesso:false, mensagem:"E-mail obrigatório." });
    const r = await db.collection("usuarios").updateOne({ $or:[{ emailLower: email }, { email }] }, { $set:{ status:"banido", banidoEm:agoraISO() } });
    if (!r.matchedCount) return res.status(404).json({ sucesso:false, mensagem:"Usuário não encontrado." });
    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao banir usuário.", detalhe:erro.message });
  }
});

app.post("/admin/usuarios/reativar", adminProtegido, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ sucesso:false, mensagem:"E-mail obrigatório." });
    const r = await db.collection("usuarios").updateOne({ $or:[{ emailLower: email }, { email }] }, { $set:{ status:"ativo", reativadoEm:agoraISO() }, $unset:{ banidoEm:"" } });
    if (!r.matchedCount) return res.status(404).json({ sucesso:false, mensagem:"Usuário não encontrado." });
    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao reativar usuário.", detalhe:erro.message });
  }
});

app.post("/admin/publicacoes/:id/remover", adminProtegido, async (req, res) => {
  try {
    const id = req.params.id;
    const filtro = isNaN(Number(id)) ? { _id: new ObjectId(id) } : { id:Number(id) };
    const r = await db.collection("publicacoes").updateOne(filtro, { $set:{ status:"removido", removidoEm:agoraISO() } });
    if (!r.matchedCount) return res.status(404).json({ sucesso:false, mensagem:"Item não encontrado." });
    res.json({ sucesso:true });
  } catch (erro) {
    res.status(500).json({ sucesso:false, mensagem:"Erro ao remover item.", detalhe:erro.message });
  }
});


async function iniciarServidor() {
  try {
    await conectarMongo();
    await migrarBancoJsonSeVazio();

    app.listen(PORTA, () => {
      console.log(`Servidor PiTiTiCo rodando na porta ${PORTA}`);
    });
  } catch (erro) {
    console.error("Erro ao iniciar servidor:", erro);
    process.exit(1);
  }
}

iniciarServidor();
