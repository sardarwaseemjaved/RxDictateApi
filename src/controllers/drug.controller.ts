import * as drugService from '../services/drug.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendData } from '../utils/response';
import type { SearchDrugsQuery } from '../shared/drug.schema';

export const searchDrugs = catchAsync(async (req, res) => {
  sendData(res, await drugService.searchDrugs(parsedQuery<SearchDrugsQuery>(req)));
});
