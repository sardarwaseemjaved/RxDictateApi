const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { toJSON } = require('./plugins');

/**
 * A one-time passcode issued for a login or registration attempt.
 *
 * Codes are stored hashed, so a dump of this collection cannot be replayed.
 * `identifier` is the normalized email or phone the code was sent to; for
 * registration there is no AppUser yet, which is why this keyed by identifier
 * rather than by user id.
 */
const passcodeSchema = mongoose.Schema(
  {
    identifier: {
      type: String,
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      private: true,
    },
    purpose: {
      type: String,
      enum: ['login', 'register'],
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

passcodeSchema.plugin(toJSON);

// Let Mongo reap expired codes on its own.
passcodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Check a plaintext code against the stored hash.
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
passcodeSchema.methods.isCodeMatch = async function (candidate) {
  return bcrypt.compare(candidate, this.code);
};

passcodeSchema.pre('save', async function (next) {
  const passcode = this;
  if (passcode.isModified('code')) {
    passcode.code = await bcrypt.hash(passcode.code, 8);
  }
  next();
});

/**
 * @typedef Passcode
 */
const Passcode = mongoose.model('Passcode', passcodeSchema);

module.exports = Passcode;
