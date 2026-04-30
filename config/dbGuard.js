function validateReplyTarget({ telegram_chat_id, telegram_user_id } = {}, env = "development") {
  if (env !== "production") return true;

  if (!telegram_chat_id || !telegram_user_id) {
    throw new Error(
      JSON.stringify({
        code: "INVALID_REPLY_TARGET",
        message: "telegram_chat_id and telegram_user_id required in production",
      })
    );
  }

  return true;
}

module.exports = { validateReplyTarget };
