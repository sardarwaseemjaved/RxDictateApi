const moment = require('moment');

const objectId = (value, helpers) => {
  if (!value.match(/^[0-9a-fA-F]{24}$/)) {
    return helpers.message('"{{#label}}" must be a valid mongo id');
  }
  return value;
};

const password = (value, helpers) => {
  if (value.length < 8) {
    return helpers.message('password must be at least 8 characters');
  }
  if (!value.match(/\d/) || !value.match(/[a-zA-Z]/)) {
    return helpers.message('password must contain at least 1 letter and 1 number');
  }
  return value;
};

const date = (value, helpers) => {
  // strict parsing, so that both the format and the calendar date must be valid
  if (!moment(value, 'YYYY-MM-DD', true).isValid()) {
    return helpers.message('"{{#label}}" must be a valid date in the format YYYY-MM-DD');
  }
  return value;
};

const time = (value, helpers) => {
  // zero padded 24 hour time, which is what makes times comparable as plain strings
  if (!value.match(/^([01]\d|2[0-3]):[0-5]\d$/)) {
    return helpers.message('"{{#label}}" must be a valid time in the format HH:mm');
  }
  return value;
};

module.exports = {
  objectId,
  password,
  date,
  time,
};
