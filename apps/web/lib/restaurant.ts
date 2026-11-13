import {cache} from 'react';

import {getDataSource} from '@/lib/data';

export const getCurrentRestaurant = cache(() => getDataSource().getRestaurant());
