const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
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
      await usuariosCollection.findOne({ deviceId }) ||
      await usuariosCollection.findOne({ emailLower });

    if (usuario) {
      if (usuario.status === "banido") {
        return res.status(403).json({
          sucesso: false,
          mensagem: "Este usuário foi removido/banido e não pode acessar o aplicativo."
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
            atualizadoEm: agoraISO()
          }
        }
      );

      usuario = await usuariosCollection.findOne({ _id: usuario._id });
    } else {
      usuario = {
        id: Date.now(),
        deviceId,
        nome,
        email,
        emailLower,
        whatsapp,
        senha: senhaFinal,
        status: "ativo",
        criadoEm: agoraISO(),
        atualizadoEm: agoraISO()
      };

      await usuariosCollection.insertOne(usuario);
    }

    res.json({
      sucesso: true,
      mensagem: "Usuária salva com sucesso.",
      usuario
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
      senha,
      status: { $ne: "banido" }
    });

    if (!usuario) {
      return res.status(401).json({
        sucesso: false,
        mensagem: "E-mail ou senha inválidos, ou usuário banido."
      });
    }

    res.json({ sucesso: true, usuario });
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

app.get("/admin/usuarios", async (req, res) => {
  try {
    await limparExpirados();

    const usuarios = await usuariosCollection.find({}).toArray();
    const publicacoes = await publicacoesCollection.find({}).toArray();

    const resposta = usuarios.map(usuario => {
      const itens = publicacoes.filter(item => itemPertenceAoUsuario(item, usuario));

      return {
        ...usuario,
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

app.delete("/admin/usuarios/:id", async (req, res) => {
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

app.post("/admin/usuarios/:id/reativar", async (req, res) => {
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

app.get("/admin/publicacoes", async (req, res) => {
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
