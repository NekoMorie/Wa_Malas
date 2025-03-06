const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
} = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {WebSocketServer} = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server});
const port = 3000;

let pb = null;

// Add this after the existing variable declarations at the top
const messageCounters = new Map();
const MESSAGE_THRESHOLD = 3;
const IKLAN_FOLDER = "./asset/iklan";
const QURAN_FOLDER = "./asset/quran";
const lastAdTime = new Map(); // Track last ad time per user

// Add array of advertising messages
const AUTO_RESPONSE_MESSAGES = [
  "Percantik hari-harimu dengan sentuhan lembut dari Wardah! ✨ Hadir dengan rangkaian produk halal dan berkualitas, yang dirancang untuk menjaga kecantikan alami dan merawat kulitmu dengan penuh kelembutan. Temukan kepercayaan diri dalam setiap senyuman, karena Wardah selalu ada untuk menemani setiap langkahmu. Cantik dari hati, bersinar di setiap momen! 🌸\n\n#WardahBeauty #CantikDariHati #SelaluAdaBahagia #GlowWithWardah #HalalBeauty #PercayaDiriBersamaWardah\n\nInstagram @wardahbeauty \nhttps://www.instagram.com/wardahbeauty?igsh=dmgyMWZvOWxqanlz ",
  "💧 Segarnya alami, manfaatnya nyata! Le Minerale hadir dengan kandungan mineral alami yang menyehatkan, memberikan hidrasi yang lebih segar dan berkualitas. Setiap tegukan menghadirkan sensasi unik, seperti ada manis-manisnya! ✨ Rasakan perbedaannya dan jadikan Le Minerale pilihan utama untuk menjaga kesehatan keluarga. Le Minerale, lebih dari sekadar air mineral! 💦\n\n#LeMinerale #SepertiAdaManisManisnya #LebihDariSekadarAirMineral #HidrasiSehat #SegarnyaBeda #SehatSetiapTetes\n\nInstagram @le_mineraleid \nhttps://www.instagram.com/le_mineraleid?igsh=Mmd0cXBmb2lzOTY1",
  "Nikmati kesegaran alami dengan Teh Botol Sosro!🍻 Dibuat dari teh pilihan dan gula asli, menghadirkan rasa autentik yang tak tergantikan. Setiap tegukan membawa kesejukan dan kebaikan dalam satu botol. Teh Botol Sosro, selalu ada di setiap momen berharga!👫\n\n#TehBotolSosro #SebotolKebaikan #RasakanKesegaran #100PersenAsli #SelaluAdaSelaluBersama #TehAsliTehKita\n\nInstagram @tehbotolsosroid\nhttps://www.instagram.com/tehbotolsosroid?igsh=MXA4cG96YnJjb2NvaA==",
];

// Initialize PocketBase
async function initPocketBase() {
  const PocketBase = (await import("pocketbase")).default;
  pb = new PocketBase("https://rapi2.robotahli.id");
}

// Call initPocketBase immediately
initPocketBase().catch(console.error);

// Set EJS as the view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));

// Create public/media directory if it doesn't exist
if (!fs.existsSync("public/media")) {
  fs.mkdirSync("public/media", {recursive: true});
}

// Store messages and connected WebSocket clients
let messages = [];
let sock = null;
let wsClients = new Set();

// Store pending emergency reports
const pendingReports = new Map();

// Helper function to get message type and content
function getMessageContent(msg) {
  const content = extractMessageContent(msg.message);
  const type = getContentType(content) || "unknown";
  return {type, content};
}

// Helper function to format phone number
function formatPhoneNumber(jid) {
  return jid.replace("@s.whatsapp.net", "");
}

// Helper function to handle media messages
async function handleMediaMessage(msg, messageType, content) {
  try {
    const mediaTypes = {
      imageMessage: {ext: "jpg", mimePrefix: "image/"},
      videoMessage: {ext: "mp4", mimePrefix: "video/"},
      audioMessage: {ext: "mp3", mimePrefix: "audio/"},
      stickerMessage: {ext: "webp", mimePrefix: "image/"},
      documentMessage: {ext: "", mimePrefix: ""},
    };

    if (mediaTypes[messageType]) {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: console,
          reuploadRequest: sock.updateMediaMessage,
        }
      );

      const ext =
        messageType === "documentMessage"
          ? content.fileName.split(".").pop()
          : mediaTypes[messageType].ext;

      const fileName = `${msg.key.id}.${ext}`;
      const filePath = path.join("public", "media", fileName);

      fs.writeFileSync(filePath, buffer);
      return `/media/${fileName}`;
    }
    return null;
  } catch (error) {
    console.error("Error handling media message:", error);
    return null;
  }
}

// WebSocket connection handler
wss.on("connection", (ws) => {
  wsClients.add(ws);

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});

// Function to broadcast QR code to all connected clients
async function broadcastQR(qr) {
  try {
    const qrDataURL = await QRCode.toDataURL(qr);
    const data = JSON.stringify({type: "qr", qr: qrDataURL});

    wsClients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    });
  } catch (error) {
    console.error("Error broadcasting QR:", error);
  }
}

async function connectToWhatsApp() {
  const {state, saveCreds} = await useMultiFileAuthState("wa_credentials");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on("connection.update", async (update) => {
    const {connection, lastDisconnect, qr} = update;

    if (qr) {
      await broadcastQR(qr);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      const data = JSON.stringify({type: "status", status: "connected"});
      wsClients.forEach((client) => {
        if (client.readyState === client.OPEN) {
          client.send(data);
        }
      });
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type === "notify") {
      for (const msg of m.messages) {
        const {type: messageType, content} = getMessageContent(msg);
        const mediaPath = await handleMediaMessage(msg, messageType, content);
        const sender = msg.key.remoteJid;

        // Skip processing if message is from us
        if (msg.key.fromMe) continue;

        // Extract text content based on message type
        let textContent = "";
        if (messageType === "conversation") {
          textContent = content.conversation;
        } else if (messageType === "extendedTextMessage") {
          textContent = content.extendedTextMessage?.text;
        }

        // Track "bacaan" requests
        if (textContent && textContent.toLowerCase().includes("bacaan")) {
          const currentCount = messageCounters.get(sender) || 0;
          messageCounters.set(sender, currentCount + 1);

          // Check if threshold reached
          if (currentCount + 1 >= MESSAGE_THRESHOLD) {
            // Reset counter
            messageCounters.set(sender, 0);

            // Check if we've sent an ad in the last 24 hours
            const lastTime = lastAdTime.get(sender) || 0;
            const now = Date.now();
            const hasShownAdToday = now - lastTime < 24 * 60 * 60 * 1000;

            if (!hasShownAdToday) {
              // Haven't shown ad today, send image ad
              const iklanData = await getRandomIklan();
              if (iklanData) {
                // Get corresponding message for this iklan
                const message =
                  AUTO_RESPONSE_MESSAGES[iklanData.index] ||
                  AUTO_RESPONSE_MESSAGES[0];
                await sock.sendMessage(sender, {
                  image: {url: iklanData.path},
                  caption: message,
                });
                // Update last ad time
                lastAdTime.set(sender, now);
              }
            }
          }
        }

        // Check for surah command
        const surahMatch = textContent.match(
          /^bacaan surah (.+?)(?: ayat (\d+(?:-\d+)?))?\s*$/i
        );
        if (surahMatch) {
          try {
            const [, requestedSurah, verseRange] = surahMatch;
            const surahData = await getSurahData(requestedSurah);

            if (surahData) {
              const verses = verseRange ? parseVerseRange(verseRange) : null;
              const formattedText = formatSurahText(surahData, verses, sender);
              await sock.sendMessage(msg.key.remoteJid, {text: formattedText});
            } else {
              await sock.sendMessage(msg.key.remoteJid, {
                text: "Maaf, surah tidak ditemukan. Pastikan nama surah benar.",
              });
            }
          } catch (error) {
            console.error("Error handling surah command:", error);
            await sock.sendMessage(msg.key.remoteJid, {
              text: "Maaf, terjadi kesalahan saat memproses permintaan.",
            });
          }
        }

        // Handle other existing message types (1#, etc)
        if (textContent && textContent.startsWith("1#")) {
          const reportText = textContent.substring(2).trim();

          // Update message counter for this sender
          if (!messageCounters.has(sender)) {
            messageCounters.set(sender, {
              count: 1,
              lastMessageTime: Date.now(),
            });
          } else {
            const counter = messageCounters.get(sender);
            const timeDiff = Date.now() - counter.lastMessageTime;

            // Reset counter if last message was more than 5 minutes ago
            if (timeDiff > 5 * 60 * 1000) {
              counter.count = 1;
            } else {
              counter.count += 1;
            }
            counter.lastMessageTime = Date.now();

            // Send auto-response if threshold reached
            if (counter.count === MESSAGE_THRESHOLD) {
              try {
                // Get random image and message
                const randomImagePath = getRandomIklan();
                const randomMessage = getRandomMessage();

                if (randomImagePath) {
                  // Read image file as buffer
                  const imageBuffer = fs.readFileSync(randomImagePath);

                  // Send image with random caption
                  await sock.sendMessage(sender, {
                    image: imageBuffer,
                    caption: randomMessage,
                  });
                } else {
                  // Fallback to text only if image loading fails
                  await sock.sendMessage(sender, {
                    text: randomMessage,
                  });
                }
                // Reset counter after sending response
                counter.count = 0;
              } catch (error) {
                console.error("Error sending auto-response:", error);
                // If error occurs, try sending text only
                await sock.sendMessage(sender, {
                  text: getRandomMessage(),
                });
              }
            }
          }

          // Store the pending report with the sender's ID
          pendingReports.set(sender, {
            text: reportText,
            timestamp: new Date(),
            instansiId: "xee8lf981cct2x6", // ID for emergency reports
          });

          // Send response asking for location
          await sock.sendMessage(sender, {
            text: "Silahkan kirim share lokasi untuk melaporkan kejadian.",
          });

          // Set timeout to remove pending report after 5 minutes
          setTimeout(() => {
            if (pendingReports.has(sender)) {
              pendingReports.delete(sender);
            }
          }, 5 * 60 * 1000);
        }

        // Handle location message for pending reports
        else if (
          messageType === "locationMessage" &&
          pendingReports.has(sender)
        ) {
          try {
            console.log("Processing location message for emergency report...");
            console.log("Sender:", sender);
            console.log("Message type:", messageType);
            console.log("Location content:", content);

            // Directly access locationMessage object
            const locationMessage = content.locationMessage;

            if (
              locationMessage &&
              locationMessage.degreesLatitude &&
              locationMessage.degreesLongitude &&
              pb
            ) {
              console.log("PocketBase initialized and location data available");
              const {degreesLatitude, degreesLongitude} = locationMessage;
              console.log("Location coordinates:", {
                degreesLatitude,
                degreesLongitude,
              });

              const pendingReport = pendingReports.get(sender);
              console.log("Retrieved pending report:", pendingReport);

              // Create record in PocketBase
              const data = {
                i_kode_instansi: pendingReport.instansiId,
                s_keterangan_laporan: pendingReport.text,
                i_no_hp_pengirim: sender.replace("@s.whatsapp.net", ""),
                i_longitude_laporan: degreesLongitude,
                i_latitude_laporan: degreesLatitude,
                e_status: "belum diterima",
                i_kode_instansi: pendingReport.instansiId,
              };

              console.log("Preparing data for PocketBase submission:", data);

              try {
                const record = await pb
                  .collection("tb_cc_laporan")
                  .create(data);
                console.log(
                  "Successfully created record in PocketBase:",
                  record
                );

                // Send confirmation message
                await sock.sendMessage(sender, {
                  text: "Laporan anda telah diterima dan akan segera diproses. Terima kasih.",
                });
                console.log("Confirmation message sent to user");

                // Remove the pending report
                pendingReports.delete(sender);
                console.log("Pending report removed from tracking");
              } catch (pocketbaseError) {
                console.error(
                  "Error creating record in PocketBase:",
                  pocketbaseError
                );
                console.error("Error details:", {
                  message: pocketbaseError.message,
                  data: pocketbaseError.data,
                  status: pocketbaseError.status,
                });

                // Log detailed error information
                if (pocketbaseError.data) {
                  console.error(
                    "Detailed error data:",
                    JSON.stringify(pocketbaseError.data, null, 2)
                  );
                }

                await sock.sendMessage(sender, {
                  text:
                    "Maaf, terjadi kesalahan dalam menyimpan laporan. Detail: " +
                    pocketbaseError.message,
                });
              }
            } else {
              const errorMessage = !pb
                ? "PocketBase not initialized"
                : "Invalid location data";
              console.error(errorMessage);
              console.log("PocketBase status:", !!pb);
              console.log("Location data available:", {
                latitude: !!locationMessage?.degreesLatitude,
                longitude: !!locationMessage?.degreesLongitude,
              });

              await sock.sendMessage(sender, {
                text: "Maaf, terjadi kesalahan sistem. Silahkan coba lagi dalam beberapa saat.",
              });
            }
          } catch (error) {
            console.error("Error processing location report:", error);
            console.error("Error stack:", error.stack);
            console.log("Content that caused error:", content);

            await sock.sendMessage(sender, {
              text: "Maaf, terjadi kesalahan dalam memproses laporan anda. Silahkan coba lagi.",
            });
          }
        }

        // Format the timestamp on the server side
        const formattedTimestamp = new Date(
          msg.messageTimestamp * 1000
        ).toLocaleString("en-US", {
          hour12: true,
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        // Extract conversation text from the content object
        const conversationText =
          content.conversation ||
          content.extendedTextMessage?.text ||
          content.text ||
          JSON.stringify(content);

        const messageData = {
          id: msg.key.id,
          from: formatPhoneNumber(msg.key.remoteJid),
          fromMe: msg.key.fromMe,
          pushName: msg.pushName || "Unknown",
          timestamp: formattedTimestamp, // Use the formatted timestamp
          type: messageType,
          content: conversationText, // Include the extracted conversation text
          mediaPath: mediaPath,
          raw: msg,
          quoted: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            ? {
                text:
                  msg.message.extendedTextMessage.contextInfo.quotedMessage
                    .conversation ||
                  msg.message.extendedTextMessage.contextInfo.quotedMessage
                    .extendedTextMessage?.text,
                participant: formatPhoneNumber(
                  msg.message.extendedTextMessage.contextInfo.participant
                ),
                name: msg.message.extendedTextMessage.contextInfo.quotedMessage
                  .pushName,
              }
            : null,
          mentions:
            msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
          buttons: content?.buttonsMessage?.buttons || [],
          listMessage: content?.listMessage || null,
          reactions: msg.reactions || [],
        };

        // Handle different message types
        switch (messageType) {
          case "conversation":
          case "extendedTextMessage":
            messageData.text = content.text || content;
            break;
          case "imageMessage":
          case "videoMessage":
          case "audioMessage":
            messageData.caption = content.caption;
            messageData.mimetype = content.mimetype;
            messageData.seconds = content.seconds;
            messageData.ptt = content.ptt;
            break;
          case "documentMessage":
            messageData.fileName = content.fileName;
            messageData.mimetype = content.mimetype;
            messageData.pageCount = content.pageCount;
            break;
          case "contactMessage":
          case "contactsArrayMessage":
            messageData.contacts = Array.isArray(content) ? content : [content];
            break;
          case "locationMessage":
            messageData.degreesLatitude = content.degreesLatitude;
            messageData.degreesLongitude = content.degreesLongitude;
            messageData.name = content.name;
            messageData.address = content.address;
            break;
          case "stickerMessage":
            messageData.isAnimated = content.isAnimated;
            break;
        }

        messages.unshift(messageData);
        if (messages.length > 100) messages.pop();

        console.log("Processed message data:", messageData); // Log the processed message data

        // Broadcast new message to all connected clients
        const wsData = JSON.stringify({
          type: "new_message",
          message: messageData,
        });

        wsClients.forEach((client) => {
          if (client.readyState === client.OPEN) {
            client.send(wsData);
          }
        });
      }
    }
  });
}

// Routes
app.get("/", (req, res) => {
  res.render("index", {messages, formatPhoneNumber});
});

app.get("/qr", async (req, res) => {
  if (sock?.authState?.creds?.me?.id) {
    res.send("Already connected");
    return;
  }

  res.render("qr");
});

app.post("/send", express.json(), async (req, res) => {
  const {number, message} = req.body;

  if (!sock?.authState?.creds?.me?.id) {
    res.status(400).json({error: "WhatsApp not connected"});
    return;
  }

  try {
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, {text: message});
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Add function to get random file from iklan folder
function getRandomIklan() {
  try {
    const files = fs
      .readdirSync(IKLAN_FOLDER)
      .filter(
        (file) =>
          file.toLowerCase().endsWith(".jpg") ||
          file.toLowerCase().endsWith(".png")
      );

    if (files.length === 0) {
      throw new Error("No image files found in iklan folder");
    }

    // Sort files to ensure consistent ordering
    files.sort();

    const randomIndex = Math.floor(Math.random() * files.length);
    const randomFile = files[randomIndex];

    // Extract index from filename (e.g., "iklan1.jpg" -> 1)
    const fileIndex = parseInt(randomFile.match(/\d+/)[0]) - 1;

    return {
      path: path.join(IKLAN_FOLDER, randomFile),
      index: fileIndex,
    };
  } catch (error) {
    console.error("Error getting random iklan:", error);
    return null;
  }
}

// Get random message
function getRandomMessage() {
  return AUTO_RESPONSE_MESSAGES[
    Math.floor(Math.random() * AUTO_RESPONSE_MESSAGES.length)
  ];
}

// Add this function to normalize surah names for comparison
function normalizeSurahName(name) {
  return name
    .toLowerCase()
    .replace(/['-]/g, "") // Remove hyphens and apostrophes
    .replace(/\s+/g, ""); // Remove spaces
}

// Add this function to get surah data
async function getSurahData(surahName) {
  try {
    const files = fs.readdirSync(QURAN_FOLDER);

    for (const file of files) {
      const surahData = JSON.parse(
        fs.readFileSync(path.join(QURAN_FOLDER, file), "utf8")
      );

      // Pastikan data dan namaLatin ada
      if (surahData && surahData.data && surahData.data.namaLatin) {
        const normalizedNameLatin = normalizeSurahName(
          surahData.data.namaLatin
        );
        const normalizedInput = normalizeSurahName(surahName);

        if (normalizedNameLatin === normalizedInput) {
          return surahData.data;
        }
      }
    }
    return null;
  } catch (error) {
    console.error("Error reading surah data:", error);
    return null;
  }
}

// Add this function to parse verse range
function parseVerseRange(rangeStr) {
  if (!rangeStr) return null;

  // Check if it's a range (e.g., "1-4") or single number
  const match = rangeStr.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;

  const start = parseInt(match[1]);
  const end = match[2] ? parseInt(match[2]) : start;

  return {start, end};
}

// Modify the format surah text function
function formatSurahText(surah, verses = null, sender) {
  try {
    // Validasi data surah
    if (!surah || !surah.namaLatin || !surah.nama || !surah.ayat) {
      throw new Error("Data surah tidak lengkap");
    }

    let text = "";

    // Check message counter and last ad time
    const currentCount = messageCounters.get(sender) || 0;
    const lastTime = lastAdTime.get(sender) || 0;
    const now = Date.now();
    const hasShownAdToday = now - lastTime < 24 * 60 * 60 * 1000;

    // Add slogan if threshold reached and we've already shown an ad today
    if (currentCount + 1 >= MESSAGE_THRESHOLD && hasShownAdToday) {
      // Get the index of the last shown ad for this user
      const lastAdIndex = messageCounters.get(`${sender}_last_ad_index`) || 0;
      const message =
        AUTO_RESPONSE_MESSAGES[lastAdIndex] || AUTO_RESPONSE_MESSAGES[0];
      text += `${message}\n\n`;
      // Reset counter
      messageCounters.set(sender, 0);
    }

    // Add surah information
    text += `*Surah ${surah.namaLatin} (${surah.nama})*\n`;
    text += `Nomor: ${surah.nomor}\n`;

    // If verses specified, show range info
    if (verses) {
      if (verses.start < 1 || verses.end > surah.jumlahAyat) {
        return `Maaf, ayat yang diminta di luar jangkauan. Surah ${surah.namaLatin} memiliki ${surah.jumlahAyat} ayat.`;
      }
      text += `Ayat: ${verses.start}${
        verses.start !== verses.end ? `-${verses.end}` : ""
      }\n`;
    }
    text += `Jumlah Ayat: ${surah.jumlahAyat}\n\n`;

    // Pastikan ayat adalah array sebelum menggunakan forEach
    if (Array.isArray(surah.ayat)) {
      surah.ayat.forEach((ayat) => {
        if (ayat && ayat.nomorAyat) {
          // Skip if verse number is outside requested range
          if (
            verses &&
            (ayat.nomorAyat < verses.start || ayat.nomorAyat > verses.end)
          ) {
            return;
          }

          text += `*Ayat ${ayat.nomorAyat}*\n`;
          text += `${ayat.teksArab || ""}\n`;
          text += `${ayat.teksLatin || ""}\n`;
          text += `${ayat.teksIndonesia || ""}\n\n`;
        }
      });
    }

    return text;
  } catch (error) {
    console.error("Error formatting surah text:", error);
    return "Maaf, terjadi kesalahan saat memformat data surah.";
  }
}

// Start server and WhatsApp connection
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  connectToWhatsApp();
});
