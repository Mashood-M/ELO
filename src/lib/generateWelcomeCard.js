const { createCanvas, loadImage } = require('canvas');

/**
 * Generates an arcade-themed 800x300 PNG welcome card for verified members.
 * 
 * @param {string} avatarUrl - Direct URL to member avatar
 * @param {string} displayName - Member display name
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateWelcomeCard(avatarUrl, displayName) {
  const width = 800;
  const height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const THEME_ORANGE = '#FF6B00';
  const TEXT_DARK = '#111827';
  const TEXT_MUTED = '#6B7280';

  // 1. Crisp white background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2. Bold arcade orange borders & accent header
  // Top header stripe
  ctx.fillStyle = THEME_ORANGE;
  ctx.fillRect(0, 0, width, 14);

  // Bottom subtle stripe
  ctx.fillStyle = THEME_ORANGE;
  ctx.fillRect(0, height - 8, width, 8);

  // Outer framing border
  ctx.strokeStyle = THEME_ORANGE;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, height - 6);

  // Decorative arcade accent corner
  ctx.fillStyle = THEME_ORANGE;
  ctx.fillRect(width - 40, 14, 26, 4);
  ctx.fillRect(width - 20, 14, 6, 24);

  // 3. User Avatar (Circle on the left side)
  const avatarCenterX = 145;
  const avatarCenterY = 150;
  const avatarRadius = 75;

  let avatarLoaded = false;
  if (avatarUrl) {
    try {
      const avatarImg = await loadImage(avatarUrl);
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(
        avatarImg,
        avatarCenterX - avatarRadius,
        avatarCenterY - avatarRadius,
        avatarRadius * 2,
        avatarRadius * 2
      );
      ctx.restore();
      avatarLoaded = true;
    } catch (err) {
      console.warn('[generateWelcomeCard] Failed to load avatar image:', err.message);
    }
  }

  // Fallback if avatar failed or missing
  if (!avatarLoaded) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2, true);
    ctx.fillStyle = '#F3F4F6';
    ctx.fill();
    ctx.fillStyle = THEME_ORANGE;
    ctx.font = 'bold 50px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = (displayName || 'M').charAt(0).toUpperCase();
    ctx.fillText(initial, avatarCenterX, avatarCenterY);
    ctx.restore();
  }

  // Ring around avatar
  ctx.beginPath();
  ctx.arc(avatarCenterX, avatarCenterY, avatarRadius + 4, 0, Math.PI * 2, true);
  ctx.strokeStyle = THEME_ORANGE;
  ctx.lineWidth = 5;
  ctx.stroke();

  // 4. Text Information on Right Side
  const textStartX = 265;
  ctx.textAlign = 'left';

  // Subtitle / Chapter Welcome header
  ctx.fillStyle = THEME_ORANGE;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('⚡ ELEVATES OS • CHAPTER MEMBER', textStartX, 95);

  // Large Bold Display Name (truncated if too wide)
  ctx.fillStyle = TEXT_DARK;
  let fontSize = 38;
  ctx.font = `bold ${fontSize}px sans-serif`;

  let nameToRender = displayName || 'Member';
  const maxTextWidth = 490;
  while (ctx.measureText(nameToRender).width > maxTextWidth && fontSize > 24) {
    fontSize -= 2;
    ctx.font = `bold ${fontSize}px sans-serif`;
  }
  if (ctx.measureText(nameToRender).width > maxTextWidth) {
    while (ctx.measureText(nameToRender + '...').width > maxTextWidth && nameToRender.length > 3) {
      nameToRender = nameToRender.slice(0, -1);
    }
    nameToRender += '...';
  }
  ctx.fillText(nameToRender, textStartX, 145);

  // Role Badge / Status line
  ctx.fillStyle = THEME_ORANGE;
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('✅ Verified Member', textStartX, 185);

  // Secondary subtext line
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = '16px sans-serif';
  ctx.fillText('Welcome to the chapter! Chapter clusters & tasks unlocked.', textStartX, 220);

  return canvas.toBuffer('image/png');
}

// In-memory set to prevent duplicate welcome card broadcasts in the same session
const postedWelcomeUsers = new Set();

/**
 * Posts the generated welcome card to #general-chat upon verified role assignment.
 */
async function postVerificationWelcomeCard(guild, member, displayName) {
  const config = require('../config');
  if (!config.features?.welcomeCard) return false;
  if (!guild || !member) return false;

  const cacheKey = `${guild.id}:${member.id}`;
  if (postedWelcomeUsers.has(cacheKey)) return false;

  try {
    const { AttachmentBuilder } = require('discord.js');
    const generalChannel = guild.channels.cache.find(
      (c) =>
        c.isTextBased &&
        c.isTextBased() &&
        (c.name === 'general-chat' || c.name === 'general') &&
        c.permissionsFor(guild.members.me)?.has(['SendMessages', 'AttachFiles'])
    );

    if (!generalChannel) return false;

    postedWelcomeUsers.add(cacheKey);

    const avatarUrl = member.user?.displayAvatarURL
      ? member.user.displayAvatarURL({ extension: 'png', size: 256 })
      : null;

    const cardBuffer = await generateWelcomeCard(avatarUrl, displayName || member.displayName);
    const attachment = new AttachmentBuilder(cardBuffer, { name: 'welcome-card.png' });

    await generalChannel.send({
      content: `🎉 Everyone give a warm welcome to ${member}! Official ElevatesOS account verified. 🎮`,
      files: [attachment],
    });

    return true;
  } catch (err) {
    console.error('[postVerificationWelcomeCard] Failed to post welcome card:', err.message);
    return false;
  }
}

module.exports = { generateWelcomeCard, postVerificationWelcomeCard };
